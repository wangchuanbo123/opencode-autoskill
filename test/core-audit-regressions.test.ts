import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsDefault from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { ReuseEngine } from "../dist/reuse.js";
import { SkillStore } from "../dist/skills.js";
import { readOptions } from "../dist/config.js";
import { digest } from "../dist/tasks.js";
import { AutoSkillEngine } from "../dist/engine.js";
import { QueueStore } from "../dist/jobs.js";
import { defaultPortableConfig, sha256 } from "../dist/portable/install.js";
import { syncNativeSkills } from "../dist/portable/sync.js";
import type { EnginePort, TaskSnapshot } from "../src/types.ts";

const cleanups = new Map<string, (() => Promise<unknown>)[]>();
function closeLater(root: string, close: () => Promise<unknown>) { cleanups.get(root)!.push(close); }
async function project(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-core-regression-"));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), JSON.stringify(defaultPortableConfig()));
  cleanups.set(root, []);
  t.after(async () => {
    for (const close of cleanups.get(root)!) await close(); cleanups.delete(root);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-core-regression-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}
async function nativeFixtures(root: string) {
  for (const id of ["alpha", "beta"]) {
    const directory = path.join(root, ".autoskill", "skills", id), provenance = path.join(root, ".autoskill", "runtime", "provenance", id);
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(provenance, { recursive: true });
    const content = `---\nname: ${id}\ndescription: fixture\nmetadata:\n  autoskill: true\n---\n# Fixture\n`;
    await fs.writeFile(path.join(directory, "SKILL.md"), content);
    await fs.writeFile(path.join(provenance, "SOURCE.json"), JSON.stringify({ skillId: id, skillSha256: sha256(content) }));
  }
}
async function failSecondExport(root: string) {
  const rename = fsDefault.rename;
  let calls = 0;
  fsDefault.rename = async (source, destination) => {
    if (String(destination).startsWith(path.join(root, ".cursor") + path.sep) && ++calls === 2) throw Object.assign(Error("Fixture disk full"), { code: "ENOSPC" });
    return rename(source, destination);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(syncNativeSkills({ root, host: "cursor" }), /disk full/); }
  finally { fsDefault.rename = rename; syncBuiltinESMExports(); }
}

test("supplemental skill admission survives restart without retaining the supplemental query", async t => {
  const root = await project(t), store = new SkillStore(root);
  const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/reuse.json", import.meta.url), "utf8"));
  const data = corpus.skills.find((skill: any) => skill.id === "migration-lock-retry");
  await store.save({ action: "create", reason: "Fixture", taskCompleted: true, reusable: true, confidence: .99,
    skill: { ...data, pitfalls: [], verification: ["Run an independent regression."] } },
  { sessionId: "source", fingerprint: "source", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  const port: EnginePort = { root, snapshot: async () => { throw Error("Unused"); }, generate: async () => { throw Error("No model"); },
    listSkills: () => store.list(), reloadSkills: async () => {}, log() {} };
  const engines: ReuseEngine[] = [], make = () => { const engine = new ReuseEngine(root, readOptions({ reuseAutoLoadLimit: 0 }), port); engines.push(engine); return engine; };
  closeLater(root, async () => { await Promise.all(engines.map(engine => engine.close())); });
  const original = "Investigate the performance regression", query = "database migration lock retry uniquequery913";
  const first = make(); await first.prepare({ sessionId: "session", messageId: "user", text: original });
  await first.context("session", undefined, "user", digest(original), original);
  await first.search({ sessionId: "session", query });
  // Even an offered candidate that has not yet been loaded retains admission.
  const second = make(); await second.context("session", undefined, "user", digest(original), original);
  assert.equal((await second.load({ sessionId: "session", skillId: data.id }) as any).status, "loaded");
  const third = make(), restored = await third.context("session", undefined, "user", digest(original), original);
  assert.match(restored!.text, /Retry transient locks within a deadline/);
  assert.doesNotMatch(JSON.stringify(await third.ledger.getTask({ sessionId: "session", anchorId: "user" })), /uniquequery913|Investigate the performance/);
  await fs.appendFile(path.join(root, ".autoskill", "skills", data.id, "SKILL.md"), "\nmanual edit\n");
  assert.doesNotMatch((await make().context("session", undefined, "user", digest(original), original))!.text, /Retry transient locks within a deadline/);
});

test("partial native export recovers ownership and remains pruneable", async t => {
  const root = await project(t); await nativeFixtures(root); await failSecondExport(root);
  const pending = path.join(root, ".autoskill", "exports", "cursor.pending.json");
  assert.ok(await fs.stat(pending));
  const preview = await syncNativeSkills({ root, host: "cursor", dryRun: true });
  assert.deepEqual(preview.conflicts, []); assert.ok(await fs.stat(pending));
  const retried = await syncNativeSkills({ root, host: "cursor" });
  assert.equal(retried.recoveredTransaction, true); assert.deepEqual(retried.conflicts, []);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".autoskill", "exports", "cursor.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.skills).sort(), ["alpha", "beta"]);
  await assert.rejects(fs.access(pending));
  await fs.unlink(path.join(root, ".autoskill", "skills", "alpha", "SKILL.md"));
  const pruned = await syncNativeSkills({ root, host: "cursor", prune: true }); assert.deepEqual(pruned.pruned, ["alpha"]);
  await assert.rejects(fs.access(path.join(root, ".cursor", "skills", "alpha", "SKILL.md")));
});

test("native export recovery protects edits made after the partial commit", async t => {
  const root = await project(t); await nativeFixtures(root); await failSecondExport(root);
  const alpha = path.join(root, ".cursor", "skills", "alpha", "SKILL.md"); await fs.appendFile(alpha, "\nUser correction\n");
  const retry = await syncNativeSkills({ root, host: "cursor" }); assert.deepEqual(retry.conflicts, ["alpha"]);
  assert.match(await fs.readFile(alpha, "utf8"), /User correction/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".autoskill", "exports", "cursor.json"), "utf8"));
  assert.ok(manifest.skills.alpha); assert.notEqual(manifest.skills.alpha.exportHash, sha256(await fs.readFile(alpha, "utf8")));
});

test("a killed native sync releases its lock and the next process recovers its export journal", async t => {
  const root = await project(t); await nativeFixtures(root);
  const syncModule = new URL("../dist/portable/sync.js", import.meta.url).href;
  const code = `import fs from 'node:fs/promises'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
    import { syncNativeSkills } from ${JSON.stringify(syncModule)};
    const root=process.argv[1], original=fs.rename; setInterval(()=>{},1000);
    fs.rename=async(source,destination)=>{ const result=await original(source,destination);
      if(String(destination)===path.join(root,'.cursor','skills','alpha','SKILL.md')) { process.stdout.write('export-committed\\n'); await new Promise(()=>{}); } return result; };
    syncBuiltinESMExports(); await syncNativeSkills({root,host:'cursor'});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  closeLater(root, async () => { child.kill("SIGKILL"); await exited; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("export-committed")) resolve(); });
      child.once("error", reject); child.once("close", () => { if (!stdout.includes("export-committed")) reject(Error(`Sync child exited before its commit: ${stderr}`)); });
      timer = setTimeout(() => reject(Error(`Sync child did not commit: ${stderr}`)), 10_000);
    });
  } finally { if (timer) clearTimeout(timer); child.kill("SIGKILL"); await exited; }
  const lockDirectory = path.join(root, ".autoskill", "operation-locks", "native-exports.lock");
  assert.equal((await fs.lstat(lockDirectory)).isDirectory(), true);
  // The historical wx protocol cannot enter while the persistent guard exists.
  await assert.rejects(fs.open(lockDirectory, "wx"), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  const retry = await syncNativeSkills({ root, host: "cursor" });
  assert.equal(retry.recoveredTransaction, true); assert.deepEqual(retry.conflicts, []);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".autoskill", "exports", "cursor.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.skills).sort(), ["alpha", "beta"]);
});

test("native sync preserves a legacy lock file for explicit inspection", async t => {
  const root = await project(t), file = path.join(root, ".autoskill", "operation-locks", "native-exports.lock");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{"pid":12345}\n');
  await assert.rejects(syncNativeSkills({ root, host: "cursor" }), /legacy.*lock requires inspection/i);
  assert.equal(await fs.readFile(file, "utf8"), '{"pid":12345}\n');
});

test("partial native prune recovers deleted entries and retries the remaining deletion", async t => {
  const root = await project(t); await nativeFixtures(root); await syncNativeSkills({ root, host: "cursor" });
  for (const id of ["alpha", "beta"]) await fs.unlink(path.join(root, ".autoskill", "skills", id, "SKILL.md"));
  const unlink = fsDefault.unlink; let calls = 0;
  fsDefault.unlink = async file => {
    if (String(file).startsWith(path.join(root, ".cursor") + path.sep) && ++calls === 2) throw Object.assign(Error("Fixture deletion denied"), { code: "EACCES" });
    return unlink(file);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(syncNativeSkills({ root, host: "cursor", prune: true }), /deletion denied/); }
  finally { fsDefault.unlink = unlink; syncBuiltinESMExports(); }
  const retry = await syncNativeSkills({ root, host: "cursor", prune: true }); assert.deepEqual(retry.conflicts, []);
  for (const id of ["alpha", "beta"]) await assert.rejects(fs.access(path.join(root, ".cursor", "skills", id, "SKILL.md")));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".autoskill", "exports", "cursor.json"), "utf8")).skills, {});
});

function capturedSnapshot(root: string, revision: number): TaskSnapshot {
  return { sessionId: "session", directory: root, terminal: "success", revision, turnId: "turn", messages: [
    { id: "user", role: "user", text: "Investigate migration lock recovery and independently verify the diagnosis", tools: [] },
    { id: "assistant", role: "assistant", text: "Investigated and verified", tools: [
      { id: "diagnosis", name: "shell", status: "completed", input: { command: "inspect migration lock" }, output: "Root cause: transient database migration lock because another transaction is unfinished; choose bounded retry after comparing lock recovery approaches." },
      { id: "verification", name: "shell", status: "completed", input: { command: "npm test migration-lock" }, output: "Independent migration lock regression: 12 tests passed and lock retry verified." },
    ] },
  ] };
}
test("a rejected in-flight capture cannot revive its invalidated request", async t => {
  const root = await project(t); let rejectSnapshot!: (error: Error) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const engine = new AutoSkillEngine({ root, backgroundWorker: false, options: { globalStateDirectory: path.join(root, "budget") },
    snapshot: async () => { entered(); return new Promise((_, reject) => { rejectSnapshot = reject; }); },
    generate: async () => { throw Error("No model"); }, listSkills: async () => [], reloadSkills: async () => {}, log() {} });
  closeLater(root, () => engine.dispose());
  const capture = engine.enqueue("session", "success"); await started; await engine.invalidate("session");
  rejectSnapshot(Error("Snapshot unavailable")); assert.equal((await capture).status, "cancelled");
  const status = await engine.status() as any; assert.equal(status.jobs[0].status, "cancelled"); assert.equal(status.jobs[0].reasonCode, "task_revised");
});

test("a late successful capture cannot replace newer evidence from another engine", async t => {
  const root = await project(t); let resolveOld!: (snapshot: TaskSnapshot) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), queue = new QueueStore(root);
  const base: EnginePort = { root, backgroundWorker: false, options: { minComplexityScore: 1, globalStateDirectory: path.join(root, "budget") },
    snapshot: async () => capturedSnapshot(root, 2), generate: async () => { throw Error("No model"); }, listSkills: async () => [], reloadSkills: async () => {}, log() {} };
  const older = new AutoSkillEngine({ ...base, snapshot: async () => { entered(); return new Promise(resolve => { resolveOld = resolve; }); } }), newer = new AutoSkillEngine(base);
  closeLater(root, async () => { await Promise.all([older.dispose(), newer.dispose()]); await queue.close(); });
  const oldCapture = older.enqueue("session", "success"); await started; await newer.invalidate("session");
  assert.equal((await newer.enqueue("session", "success")).status, "queued");
  resolveOld(capturedSnapshot(root, 1)); assert.equal((await oldCapture).status, "cancelled");
  const jobs = Object.values((await queue.read()).jobs).filter(job => job.snapshot);
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.snapshot!.revision, 2); assert.equal(jobs[0]!.status, "pending");
});

test("a drain paused in queue I/O cannot replace a later manual review capture", async t => {
  const root = await project(t); let snapshotCalls = 0, enterManual!: () => void, resolveManual!: (value: TaskSnapshot) => void;
  const manualStarted = new Promise<void>(resolve => { enterManual = resolve; });
  const snapshot = capturedSnapshot(root, 1);
  const engine = new AutoSkillEngine({ root, backgroundWorker: false, options: { minComplexityScore: 1, globalStateDirectory: path.join(root, "budget") },
    snapshot: async () => {
      if (++snapshotCalls === 2) { enterManual(); return new Promise(resolve => { resolveManual = resolve; }); }
      return structuredClone(snapshot);
    }, generate: async () => { throw Error("An already published task must not call the model"); }, listSkills: async () => [], reloadSkills: async () => {}, log() {} });
  closeLater(root, () => engine.dispose());
  await engine.enqueue("session", "success");
  const queue = (engine as any).queue as QueueStore;
  await queue.transaction(state => { for (const job of Object.values(state.jobs)) if (job.snapshot) job.status = "saved"; });
  const originalRead = queue.read.bind(queue); let first = true, enterRead!: () => void, releaseRead!: () => void;
  const readEntered = new Promise<void>(resolve => { enterRead = resolve; });
  const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
  queue.read = async () => { if (first) { first = false; enterRead(); await readReleased; } return originalRead(); };
  const draining = (engine as any).drain(); await readEntered;
  const manual = engine.review("session"); await manualStarted;
  try { releaseRead(); await draining; }
  finally { resolveManual(structuredClone(snapshot)); queue.read = originalRead; }
  assert.equal((await manual).reasonCode, "already_reviewed"); assert.equal(snapshotCalls, 2);
});
