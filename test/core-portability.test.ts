import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createLegacyStorageLayout, createPortableStorageLayout, resolveStorageLayout } from "../dist/storage-layout.js";
import { collectTasks, digest, scopedSessionId } from "../dist/tasks.js";
import { readOptions } from "../dist/config.js";
import { SkillStore } from "../dist/skills.js";
import { QueueStore } from "../dist/jobs.js";
import { ReuseEngine } from "../dist/reuse.js";
import { AutoSkillEngine } from "../dist/engine.js";
import type { EnginePort, TaskSnapshot } from "../src/types.ts";

async function project(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-core-portability-"));
  t.after(async () => {
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
  const queue = new QueueStore(root); t.after(() => queue.close());
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
  assert.notEqual(completed.taskId, collectTasks({ ...first, revision: 2 }, options, root)[0]!.taskId);
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
  t.after(async () => { await a.close(); await b.close(); });
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
  t.after(async () => { await a.dispose(); await b.dispose(); });
  assert.equal((await a.enqueue("native-session")).status, "queued");
  await delay(350);
  assert.equal(models, 0);
  assert.equal(otherSnapshots, 0);
});

test("origin policy blocks internal calls and requires explicit independent child publication", async (t) => {
  const root = await project(t);
  const source = snapshot(root, { hostId: "host-a", workspaceId: "workspace", origin: { kind: "reviewer" } });
  const engine = new AutoSkillEngine(port(root, source)); t.after(() => engine.dispose());
  assert.equal((await engine.enqueue("native-session")).reasonCode, "outside_scope");
  source.origin = { kind: "subagent", parentTaskId: "parent-task" };
  assert.equal((await engine.enqueue("native-session")).reasonCode, "outside_scope");
  const independent = new AutoSkillEngine(port(root, source, { options: { agentPolicy: "independent", globalStateDirectory: path.join(root, "private-global") } }));
  t.after(() => independent.dispose());
  assert.equal((await independent.enqueue("native-session")).status, "queued");
  assert.throws(() => readOptions({ agentPolicy: "unrestricted" }), /agentPolicy/);
});
