import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createLegacyStorageLayout, createPortableStorageLayout, resolveStorageLayout } from "../dist/storage-layout.js";
import { collectTasks, digest, scopedSessionId } from "../dist/tasks.js";
import { readOptions } from "../dist/config.js";
import { SkillStore } from "../dist/skills.js";
import { QueueStore } from "../dist/jobs.js";
import { ReuseEngine } from "../dist/reuse.js";
import { AutoSkillEngine } from "../dist/engine.js";
import { filterManagedSkillCatalog, resolveManagedSkillAliases, setupAdapter } from "../dist/adapters/opencode/index.js";
import { syncNativeSkills } from "../dist/portable/sync.js";
import { runCli } from "../bin/cli.mjs";
import type { EnginePort, TaskSnapshot } from "../src/types.ts";
import { withAssessment } from "./helpers/assessment.ts";

const disposers = new Map<string, (() => Promise<void>)[]>();
function dispose(root: string, action: () => Promise<void>) { disposers.get(root)!.push(action); }
async function project(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-core-portability-"));
  disposers.set(root, []);
  t.after(async () => {
    for (const action of disposers.get(root)!.reverse()) await action();
    disposers.delete(root);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-core-portability-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}

function snapshot(root: string, extra: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { sessionId: "native-session", directory: root, terminal: "success", messages: [
    { id: "user", role: "user", text: "Investigate migration lock recovery and verify the diagnosis", tools: [] },
    { id: "assistant", role: "assistant", text: "Investigated and checked the result.", tools: [
      { id: "diagnosis", name: "shell", status: "completed", input: { command: "inspect migration lock" }, output: "Root cause: transient database migration lock because another transaction is unfinished; choose bounded retry after comparing lock recovery approaches." },
      { id: "verification", name: "shell", status: "completed", input: { command: "npm test migration-lock" }, output: "Independent migration lock regression: 12 tests passed and lock retry verified." },
    ] },
  ], ...extra };
}

function port(root: string, source: TaskSnapshot, extra: Partial<EnginePort> = {}): EnginePort {
  return { root, hostId: source.hostId, workspaceId: source.workspaceId, backgroundWorker: false,
    options: { cooldownMs: 0, globalStateDirectory: path.join(root, "private-global") },
    snapshot: async () => structuredClone(source),
    generate: async () => JSON.stringify({ action: "skip", reason: "No additional reusable coverage", taskCompleted: true, reusable: false, confidence: 0.9 }),
    listSkills: async () => [], reloadSkills: async () => {}, log() {}, ...extra };
}

test("portable marker selects a shared repository while existing projects retain legacy storage", async (t) => {
  const root = await project(t);
  assert.deepEqual(resolveStorageLayout(root), createLegacyStorageLayout(root));
  const portable = createPortableStorageLayout(root);
  await fs.mkdir(path.dirname(portable.configFile));
  await fs.writeFile(portable.configFile, '{"version":1}\n');
  assert.deepEqual(resolveStorageLayout(root), portable);
  const store = new SkillStore(root);
  const saved = await store.save({ action: "create", reason: "fixture", taskCompleted: true, reusable: true, confidence: 0.99,
    skill: { id: "shared-lock-method", name: "Shared lock method", description: "Recover migration locks.", whenToUse: ["A transient migration lock"], prerequisites: [], steps: ["Bound retries and validate recovery."], pitfalls: [], verification: ["Run the migration lock regression."] } },
  { sessionId: "source", fingerprint: "fixture", messageIds: [], evidence: [], createdAt: new Date().toISOString(), hostId: "host-a" });
  assert.equal(saved.path, path.join(portable.skillsRoot, "shared-lock-method", "SKILL.md"));
  assert.equal((await store.inspect("shared-lock-method")).provenance.hostId, "host-a");
  const queue = new QueueStore(root); dispose(root, () => queue.close());
  await queue.read();
  assert.equal(queue.file, path.join(portable.stateRoot, "runtime.sqlite"));
  await assert.rejects(fs.access(path.join(root, ".opencode")), { code: "ENOENT" });
});

test("host identities avoid collisions and completed unknown outcomes retain their uncertainty", () => {
  const root = process.cwd(), options = readOptions();
  const first = snapshot(root, { hostId: "host-a", workspaceId: "workspace", terminal: "unknown" });
  assert.equal(collectTasks(first, options, root)[0]!.eligible, false);
  first.executionCompleted = true;
  const completed = collectTasks(first, options, root)[0]!;
  assert.equal(completed.eligible, true);
  assert.equal(completed.snapshot.terminal, "unknown");
  assert.notEqual(completed.taskId, collectTasks({ ...first, hostId: "host-b" }, options, root)[0]!.taskId);
  const revised = collectTasks({ ...first, revision: 2 }, options, root)[0]!;
  assert.equal(completed.taskId, revised.taskId); assert.notEqual(completed.id, revised.id);
  const legacy = collectTasks(snapshot(root), options, root)[0]!;
  assert.equal(legacy.taskId, digest(["native-session", "user"]));
  const second = first.messages.map(message => ({ ...structuredClone(message), id: `${message.id}-second` }));
  const multiple = collectTasks({ ...first, messages: [...first.messages, ...second] }, options, root);
  assert.equal(multiple[0]!.eligible, false);
  const bounded = collectTasks({ ...first, messages: [...first.messages, ...second], taskBoundaries: [{ messageId: "user", terminal: "unknown", executionCompleted: true }] }, options, root);
  assert.equal(bounded[0]!.eligible, true);
});

test("reuse ledger namespaces hosts without changing native session lookup or restore keys", async (t) => {
  const root = await project(t);
  const a = new ReuseEngine(root, readOptions(), port(root, snapshot(root, { hostId: "host-a", workspaceId: "workspace" })));
  const b = new ReuseEngine(root, readOptions(), port(root, snapshot(root, { hostId: "host-b", workspaceId: "workspace" })));
  dispose(root, async () => { await a.close(); await b.close(); });
  await a.prepare({ sessionId: "native-session", messageId: "user", text: "Migration lock retry" });
  await b.prepare({ sessionId: "native-session", messageId: "user", text: "Frontend component review" });
  assert.ok(await a.ledger.getTask({ sessionId: scopedSessionId("native-session", "host-a", "workspace"), anchorId: "user" }));
  assert.ok(await b.ledger.getTask({ sessionId: scopedSessionId("native-session", "host-b", "workspace"), anchorId: "user" }));
  assert.equal(await a.ledger.getTask({ sessionId: "native-session", anchorId: "user" }), undefined);
  assert.ok(await a.context("native-session", undefined, "user"));
});

test("capture hooks persist evidence without starting a model and other hosts do not claim it", async (t) => {
  const root = await project(t);
  const source = snapshot(root, { hostId: "host-a", workspaceId: "workspace", terminal: "unknown", executionCompleted: true });
  let models = 0, otherSnapshots = 0;
  const a = new AutoSkillEngine(port(root, source, { generate: async () => { models++; throw new Error("must not start"); } }));
  const b = new AutoSkillEngine(port(root, { ...source, hostId: "host-b" }, { backgroundWorker: true, snapshot: async () => { otherSnapshots++; throw new Error("foreign job"); } }));
  dispose(root, async () => { await a.dispose(); await b.dispose(); });
  assert.equal((await a.enqueue("native-session")).status, "queued");
  await delay(350);
  assert.equal(models, 0);
  assert.equal(otherSnapshots, 0);
});

test("origin policy blocks internal calls and requires explicit independent child publication", async (t) => {
  const root = await project(t);
  const source = snapshot(root, { hostId: "host-a", workspaceId: "workspace", origin: { kind: "reviewer" } });
  const engine = new AutoSkillEngine(port(root, source)); dispose(root, () => engine.dispose());
  assert.equal((await engine.enqueue("native-session")).reasonCode, "outside_scope");
  source.origin = { kind: "subagent", parentTaskId: "parent-task" };
  assert.equal((await engine.enqueue("native-session")).reasonCode, "outside_scope");
  const independent = new AutoSkillEngine(port(root, source, { options: { agentPolicy: "independent", globalStateDirectory: path.join(root, "private-global") } }));
  dispose(root, () => independent.dispose());
  assert.equal((await independent.enqueue("native-session")).status, "queued");
  assert.throws(() => readOptions({ agentPolicy: "unrestricted" }), /agentPolicy/);
});

test("native cmd diagnostics, changed repair and independent verification publish with an unknown host outcome", async (t) => {
  const root = await project(t);
  const outputs = {
    failure: "Migration failed with SQLITE_BUSY: database is locked during schema migration.",
    diagnosis: "Root cause: migration lock is held because the transaction remains open; bounded retry resolves a transient lock while preserving the deadline.",
    repair: "Updated migration retry policy with bounded exponential backoff and permanent schema error exclusions.",
    check: "Migration lock regression: 12 tests passed and verified bounded retry and deadline behavior.",
  };
  const source = snapshot(root, { hostId: "codex", workspaceId: "workspace", terminal: "unknown", executionCompleted: true });
  source.messages[1]!.tools = [
    { id: "failure", name: "exec_command", nativeName: "exec_command", category: "execute", status: "error", input: { cmd: "node migrate.js" }, output: outputs.failure },
    { id: "diagnosis", name: "exec_command", nativeName: "exec_command", category: "execute", status: "completed", input: { cmd: "node inspect-migration-lock.js" }, output: outputs.diagnosis },
    { id: "repair", name: "exec_command", nativeName: "exec_command", category: "execute", status: "completed", input: { cmd: "Set-Content migration-retry.js bounded-policy" }, output: outputs.repair },
    { id: "check", name: "exec_command", nativeName: "exec_command", category: "execute", status: "completed", input: { cmd: "node --test migration-lock.test.js" }, output: outputs.check },
  ];
  const citations = Object.entries(outputs).map(([toolCallId, excerpt]) => ({ toolCallId, excerpt }));
  const decision = { action: "create", reason: "Observed bounded retry resolves a transient migration lock with independent deadline regression.", taskCompleted: true, reusable: true, confidence: 0.96,
    skill: { id: "native-migration-lock-retry", name: "Native migration lock retry", description: "Recover transient schema migration locks using bounded retry.",
      whenToUse: ["A transient SQLITE_BUSY migration lock"], prerequisites: ["A reproducible migration lock fixture"],
      steps: ["Diagnose whether the migration lock is transient and identify its owning transaction.", "Apply bounded retry while excluding permanent errors, then run the lock and deadline regressions."],
      pitfalls: ["Do not retry permanent schema errors."], verification: ["Run the independent migration lock and deadline regression suite."] },
    evidence: citations.map(citation => ({ ...citation, supports: citation.toolCallId === "check" ? "verification" : "procedure" })),
    assessment: { complexity: { nontrivial: true, dimensions: [{ kind: "diagnosis-and-recovery", rationale: "An observed lock failure required diagnosing the owning transaction, changing retry policy and checking recovery independently.", evidence: citations }] },
      value: { transferable: true, nonObvious: true, addsKnowledge: true, rationale: "The transient versus permanent failure distinction and bounded deadline rule transfer to other migrations.", evidence: citations } } };
  const engine = new AutoSkillEngine(port(root, source, { generate: async () => JSON.stringify(decision) }));
  dispose(root, () => engine.dispose());
  const result = await engine.review("native-session");
  assert.equal(result.status, "saved", result.reason);
  const state = await engine.status() as any;
  assert.equal(state.jobs.find((job: any) => job.status === "saved").hostId, "codex");
  assert.equal(source.terminal, "unknown");
});

test("unchanged OpenCode exports share canonical routing while edited native exports remain external", async (t) => {
  const root = await project(t), layout = createPortableStorageLayout(root);
  await fs.mkdir(path.dirname(layout.configFile));
  await fs.writeFile(layout.configFile, JSON.stringify({ schemaVersion: 1, adapters: { opencode: { enabled: true } }, options: {}, agentPolicy: "root-only" }));
  const store = new SkillStore(root);
  const saved = await store.save({ action: "create", reason: "fixture", taskCompleted: true, reusable: true, confidence: 0.99,
    skill: { id: "migration-lock-retry", name: "Migration lock retry", description: "Recover transient database schema migration lock using bounded retry.",
      whenToUse: ["A transient database schema migration lock"], prerequisites: [], steps: ["Diagnose the transient lock before applying bounded retry.", "Run the independent migration lock and deadline regression."], pitfalls: [], verification: ["Run the independent migration lock regression."] } },
  { sessionId: "source", fingerprint: "fixture", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  await syncNativeSkills({ root, host: "opencode" });
  const exported = path.join(root, ".opencode", "skills", saved.id, "SKILL.md");
  const native = [{ id: "native-managed", name: saved.id, description: "Native exported migration lock method", path: exported, content: await fs.readFile(exported, "utf8"), managed: false }];
  const aliases = await resolveManagedSkillAliases(root, native);
  assert.equal(aliases[0]!.path, saved.path);
  assert.equal(aliases[0]!.id, "native-managed");
  const source = snapshot(root, { hostId: "opencode", workspaceId: root });
  const nativePort = port(root, source, { listSkills: () => resolveManagedSkillAliases(root, native) });
  const reuse = new ReuseEngine(root, readOptions(), nativePort); dispose(root, () => reuse.close());
  await reuse.prepare({ sessionId: "native-session", messageId: "user", text: source.messages[0]!.text });
  const context = await reuse.context("native-session", undefined, "user");
  assert.ok(context!.candidateIds.includes(saved.id));
  const aliasIds = new Set(context!.catalog.flatMap(skill => skill.hostIds ?? []));
  assert.ok(aliasIds.has("native-managed"));
  const catalog = "<available_skills><skill><id>native-managed</id><name>Migration lock retry</name></skill><skill><id>handwritten</id><name>User method</name></skill></available_skills>";
  const filtered = filterManagedSkillCatalog(catalog, aliasIds);
  assert.doesNotMatch(filtered, /native-managed/); assert.match(filtered, /handwritten/);
  let reviewed: any[] = [];
  const engine = new AutoSkillEngine({ ...nativePort, generate: async ({ prompt }) => {
    reviewed = JSON.parse(/<existing-skills>\n([^]*?)\n<\/existing-skills>/.exec(prompt)![1]!);
    return JSON.stringify({ action: "skip", reason: "Existing method covers this task", taskCompleted: true, reusable: false, confidence: 0.9 });
  } });
  dispose(root, () => engine.dispose()); await engine.review("native-session");
  assert.deepEqual(reviewed.map(skill => skill.id), [saved.id]);
  await fs.appendFile(exported, "\nManual native instructions.\n"); native[0]!.content = await fs.readFile(exported, "utf8");
  assert.equal((await resolveManagedSkillAliases(root, native))[0]!.path, exported);
  const modifiedContext = await reuse.context("native-session", undefined, "user");
  assert.ok(!modifiedContext!.catalog.some(skill => skill.hostIds?.includes("native-managed")));
  assert.match(await fs.readFile(exported, "utf8"), /Manual native instructions/);
});

test("OpenCode merges shared options and the native CLI reports portable runtime state", async (t) => {
  const root = await project(t), layout = createPortableStorageLayout(root);
  await fs.mkdir(path.dirname(layout.configFile));
  await fs.writeFile(layout.configFile, JSON.stringify({ schemaVersion: 1, adapters: { opencode: { enabled: true } },
    options: { maxReviewsPerDay: 4, minComplexityScore: 9, model: { providerID: "native", id: "reviewer" } }, agentPolicy: "independent" }));
  let captured: EnginePort | undefined;
  const cleanup = await setupAdapter({ app: { version: "2.2.7" }, location: { directory: root }, options: { maxReviewsPerDay: 2 }, session: {} } as any,
    (value) => { captured = value; return { schedule() {}, review: async () => ({ status: "skipped", reason: "fixture" }), status: async () => ({}), dispose: async () => {} }; });
  dispose(root, cleanup);
  assert.equal(captured!.options!.maxReviewsPerDay, 2);
  assert.equal(captured!.options!.minComplexityScore, 9);
  assert.equal(captured!.options!.agentPolicy, "independent");
  assert.deepEqual(captured!.options!.model, { providerID: "native", id: "reviewer" });
  assert.equal(captured!.hostId, "opencode");
  const queue = new QueueStore(root); dispose(root, () => queue.close()); await queue.read();
  const output: string[] = [];
  assert.equal(await runCli(["status", "--runtime", "--project", root], { out(value: string) { output.push(value); }, error(value: string) { throw new Error(value); } }), 0);
  assert.equal(JSON.parse(output.at(-1)!).runtime.status, "available");
});

test("restored original exclusions cover skills learned by another host after task admission", async (t) => {
  const root = await project(t), source = snapshot(root, { hostId: "host-a", workspaceId: "workspace" });
  const nativePort = port(root, source), options = readOptions({ reuseAutoLoadLimit: 0 });
  const original = "Investigate migration lock recovery. Do not use tenant invoice cache methods.";
  const first = new ReuseEngine(root, options, nativePort);
  await first.prepare({ sessionId: "native-session", messageId: "user", text: original }); await first.close();
  await new SkillStore(root).save({ action: "create", reason: "Learned by another host", taskCompleted: true, reusable: true, confidence: 0.99,
    skill: { id: "tenant-invoice-cache", name: "Tenant invoice cache collision isolation", description: "Isolate tenant invoice cache collisions across tenant identities.",
      whenToUse: ["A tenant invoice cache collision"], prerequisites: [], steps: ["Include tenant identity in cache keys.", "Verify that tenant invoice caches remain isolated."], pitfalls: [], verification: ["Run the cross-tenant invoice cache regression."] } },
  { sessionId: "another-host", fingerprint: "fixture", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  const reopened = new ReuseEngine(root, options, nativePort); dispose(root, () => reopened.close());
  assert.equal(await reopened.context("native-session", undefined, "user", digest(original), "A different task"), undefined);
  assert.ok(await reopened.context("native-session", undefined, "user", digest(original), original));
  const result = await reopened.search({ sessionId: "native-session", query: "Tenant invoice cache collision isolation" }) as any;
  assert.ok(!result.candidates?.some((skill: any) => skill.id === "tenant-invoice-cache"));
});

test("another process cannot publish task evidence after its queue lease is invalidated", { timeout: 15_000 }, async (t) => {
  const root = await project(t), source = snapshot(root, { hostId: "host-a", workspaceId: "workspace" });
  const evidence = source.messages[1]!.tools.map(tool => ({ toolCallId: tool.id, excerpt: tool.output, supports: tool.id === "verification" ? "verification" as const : "procedure" as const }));
  const decision = withAssessment({ action: "create", reason: "A verified lock method", taskCompleted: true, reusable: true, confidence: 0.96,
    skill: { id: "revoked-lock-method", name: "Revoked lock method", description: "Recover transient migration locks.", whenToUse: ["A transient migration lock"], prerequisites: [],
      steps: ["Diagnose the lock-owning transaction.", "Apply bounded retries and independently verify lock recovery."], pitfalls: [], verification: ["Run the lock recovery regression."] }, evidence });
  await fs.writeFile(path.join(root, "case.json"), JSON.stringify({ source, decision }));
  const script = `
    import * as fs from 'node:fs/promises';
    import path from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const root=process.argv[1]; const {AutoSkillEngine}=await import(process.argv[2]);
    const {source,decision}=JSON.parse(await fs.readFile(path.join(root,'case.json'),'utf8'));
    const engine=new AutoSkillEngine({root,hostId:source.hostId,workspaceId:source.workspaceId,backgroundWorker:false,
      options:{cooldownMs:0,globalStateDirectory:path.join(root,'private-global')},snapshot:async()=>structuredClone(source),
      listSkills:async()=>[],reloadSkills:async()=>{},log(){},generate:async()=>{process.stdout.write('provider-ready\\n');
        while(!await fs.access(path.join(root,'release')).then(()=>true,()=>false))await delay(10); return JSON.stringify(decision);}});
    try{process.stdout.write('result:'+JSON.stringify(await engine.review(source.sessionId))+'\\n');}finally{await engine.dispose();}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, new URL("../dist/engine.js", import.meta.url).href], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  dispose(root, async () => { if (child.exitCode === null) child.kill(); await exited; });
  const deadline = Date.now() + 10_000;
  while (!output.includes("provider-ready") && child.exitCode === null && Date.now() < deadline) await delay(20);
  assert.match(output, /provider-ready/, errors);
  const owner = new AutoSkillEngine(port(root, source)); dispose(root, () => owner.dispose());
  await owner.invalidate("native-session"); await fs.writeFile(path.join(root, "release"), "continue");
  assert.equal(await exited, 0, errors);
  const result = JSON.parse(/result:([^\n]+)/.exec(output)![1]!);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(await new SkillStore(root).list(), []);
  assert.ok((await owner.status() as any).jobs.some((job: any) => job.reasonCode === "task_revised"));
});

test("invalidation during transcript capture cannot requeue the superseded packet", async (t) => {
  const root = await project(t), source = snapshot(root, { hostId: "host-a", workspaceId: "workspace" });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const capture = new AutoSkillEngine(port(root, source, { snapshot: async () => { entered(); await waiting; return source; } }));
  const owner = new AutoSkillEngine(port(root, source)); dispose(root, async () => { await capture.dispose(); await owner.dispose(); });
  const operation = capture.enqueue("native-session"); await started;
  await owner.invalidate("native-session"); release();
  assert.equal((await operation).status, "cancelled");
  assert.ok(!(await owner.status() as any).jobs.some((job: any) => ["pending", "retry", "running"].includes(job.status)));
});
