import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ReuseStore, reuseTaskId } from "../dist/reuse-store.js";
import { openSqlite } from "../dist/sqlite.js";
import { ensurePrivateDirectory } from "../dist/state.js";

const task = { sessionId: "session-1", anchorId: "user-1" };
const skill = { ...task, skillId: "tenant-cache-isolation", sha256: "a".repeat(64) };
const candidate = { skillId: skill.skillId, sha256: skill.sha256, score: 0.92, reasonCodes: ["trigger_match"] };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-reuse-store-"));
  const stores: ReuseStore[] = [];
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-reuse-store-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, store() { const store = new ReuseStore(root); stores.push(store); return store; } };
}

test("reuse offers persist per task without inventing a load, application or outcome", async (t) => {
  const f = await fixture(t), store = f.store();
  const record = await store.recordSearch({ ...task, candidates: [candidate], policyVersion: "reuse-v1" });
  assert.equal(record.taskId, reuseTaskId(task));
  assert.equal(record.searched, true); assert.equal(record.outcome, "unknown");
  assert.equal(record.skills[0]!.offered, true); assert.equal(record.skills[0]!.loaded, false); assert.equal(record.skills[0]!.used, false);
  assert.equal((await store.history())[0]!.feedback.unknown, 0);
  await store.close();
  const reopened = f.store();
  assert.deepEqual(await reopened.inspect(task), record);
  assert.equal((await reopened.currentTask(task.sessionId))!.anchorId, task.anchorId);
  assert.equal((await reopened.status()).searchedTasks, 1);
});

test("user exclusions persist by skill id and merge across repeated searches without storing task text", async (t) => {
  const f = await fixture(t), store = f.store();
  const first = await store.recordSearch({ ...task, candidates: [], excludedSkillIds: ["unsafe-cache", "legacy-retry"] });
  assert.deepEqual(first.excludedSkillIds, ["unsafe-cache", "legacy-retry"]);
  const second = await store.recordSearch({ ...task, candidates: [], excludedSkillIds: ["legacy-retry", "manual-override"] });
  assert.deepEqual(second.excludedSkillIds, ["unsafe-cache", "legacy-retry", "manual-override"]);
  await store.close(); const reopened = f.store();
  assert.deepEqual((await reopened.getTask(task))!.excludedSkillIds, ["unsafe-cache", "legacy-retry", "manual-override"]);
  const names = await fs.readdir(path.dirname(reopened.file));
  assert.doesNotMatch(names.join(" "), /PRIVATE|unsafe-cache/);
  await assert.rejects(reopened.recordSearch({ ...task, candidates: [], excludedSkillIds: ["../escape"] }), /excluded/i);
});

test("automatic loads honor a per-task cap atomically while repeated and native observations remain allowed", async (t) => {
  const f = await fixture(t), store = f.store(); await store.recordSearch({ ...task, candidates: [] });
  const makeSkill = (id: string) => ({ ...skill, skillId: id });
  const results = await Promise.allSettled(["load-a", "load-b", "load-c", "load-d"].map((id) => store.recordLoad({ ...makeSkill(id), source: "automatic", maxLoaded: 2 })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  await store.recordLoad({ ...makeSkill("load-a"), source: "automatic", maxLoaded: 2 });
  await store.observeNativeLoad({ ...makeSkill("native-over-cap"), toolCallId: "native-tool" });
  assert.equal((await store.getTask(task))!.skills.filter((item) => item.loaded).length, 3);
  await assert.rejects(store.recordLoad({ ...makeSkill("load-over-cap"), source: "explicit", maxLoaded: 2 }), /load limit/i);
});

test("task completion, failure and interruption remain separate from skill feedback", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [candidate] });
  await store.recordLoad({ ...skill, source: "automatic" });
  for (const outcome of ["success", "failure", "interrupted"] as const) await store.finishTask({ ...task, outcome });
  const record = (await store.getTask(task))!;
  assert.equal(record.outcome, "interrupted"); assert.equal(record.skills[0]!.used, false); assert.equal(record.skills[0]!.feedback, "unknown");
  const stats = (await store.history())[0]!;
  assert.equal(stats.loaded, 1); assert.equal(stats.reportedUsed, 0); assert.deepEqual(stats.feedback, { success: 0, failure: 0, unknown: 1 });
  assert.deepEqual(stats.taskOutcomes, { success: 0, failure: 0, interrupted: 1, unknown: 0 });
});

test("repeated loads, native observation, application and revised feedback count once across restart", async (t) => {
  const f = await fixture(t), store = f.store();
  for (let i = 0; i < 3; i++) {
    await store.recordSearch({ ...task, candidates: [candidate] });
    await store.recordLoad({ ...skill, source: "automatic" });
    await store.observeNativeLoad({ ...skill, toolCallId: "tool-native-1" });
    await store.recordUse({ ...skill, source: "model" });
    await store.feedback({ ...skill, outcome: "success", source: "model" });
  }
  await store.close();
  const reopened = f.store();
  await reopened.feedback({ ...skill, outcome: "failure", source: "user" });
  await reopened.feedback({ ...skill, outcome: "failure", source: "user" });
  const stats = (await reopened.history())[0]!;
  assert.equal(stats.offered, 1); assert.equal(stats.loaded, 1); assert.equal(stats.nativeLoaded, 1); assert.equal(stats.reportedUsed, 1);
  assert.deepEqual(stats.feedback, { success: 0, failure: 1, unknown: 0 });
  assert.deepEqual(stats.userFeedback, { success: 0, failure: 1 }); assert.deepEqual(stats.modelFeedback, { success: 1, failure: 0 });
  assert.equal((await reopened.status()).reportedUsedTasks, 1);
});

test("a new query hash under an edited message starts a separate revision without inheriting old loads", async (t) => {
  const f = await fixture(t), store = f.store();
  const first = { ...skill, queryHash: "1".repeat(64) };
  const second = { ...skill, queryHash: "2".repeat(64) };
  await store.recordSearch({ ...first, candidates: [candidate] });
  await store.recordLoad({ ...first, source: "automatic" });
  const revision = await store.recordSearch({ ...second, candidates: [candidate] });
  assert.equal(revision.skills[0]!.loaded, false);
  assert.equal((await store.getTask(task))!.queryHash, second.queryHash);
  assert.equal((await store.currentTask(task.sessionId))!.queryHash, second.queryHash);
  assert.equal((await store.getTask(first))!.skills[0]!.loaded, true);
  await store.recordSearch({ ...second, candidates: [candidate] });
  assert.equal((await store.status()).searchedTasks, 2);
  await store.finishTask({ ...first, outcome: "success" });
  assert.equal((await store.currentTask(task.sessionId))!.queryHash, second.queryHash);
  assert.equal((await store.getTask(task))!.outcome, "unknown");
});

test("later model reports preserve separate user feedback and cannot overwrite its effective verdict", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordLoad({ ...skill, source: "automatic" });
  await store.feedback({ ...skill, outcome: "failure", source: "user" });
  await store.feedback({ ...skill, outcome: "success", source: "model" });
  const record = (await store.getTask(task))!.skills[0]!;
  assert.equal(record.feedback, "failure"); assert.equal(record.feedbackSource, "user");
  assert.equal(record.userFeedback, "failure"); assert.equal(record.modelFeedback, "success");
  assert.deepEqual((await store.history())[0]!.feedback, { success: 0, failure: 1, unknown: 0 });
});

test("feedback reports retain source and version instead of mixing models, users and skill updates", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordLoad({ ...skill, source: "explicit" });
  await store.feedback({ ...skill, outcome: "success", source: "user" });
  const second = { ...skill, anchorId: "user-2" };
  await store.recordLoad({ ...second, source: "automatic" });
  await store.feedback({ ...second, outcome: "failure", source: "model" });
  const updated = { ...skill, anchorId: "user-3", sha256: "b".repeat(64) };
  await store.recordLoad({ ...updated, source: "automatic" });
  await store.finishTask({ ...task, outcome: "success" });
  assert.equal((await store.currentTask(task.sessionId))!.anchorId, "user-3");
  const history = await store.history(skill.skillId);
  assert.equal(history.length, 2);
  assert.deepEqual(history[0]!.userFeedback, { success: 1, failure: 0 });
  assert.deepEqual(history[0]!.modelFeedback, { success: 0, failure: 1 });
  assert.equal(history[1]!.feedback.unknown, 1);
  assert.equal((await store.history(undefined, "b".repeat(64))).length, 1);
});

test("outcome timestamps permit authoritative revisions and ignore stale terminal events", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [] });
  await store.finishTask({ ...task, outcome: "failure", finishedAt: 200 });
  await store.finishTask({ ...task, outcome: "success", finishedAt: 100 });
  assert.equal((await store.getTask(task))!.outcome, "failure");
  await store.finishTask({ ...task, outcome: "success", finishedAt: 300 });
  assert.equal((await store.getTask(task))!.outcome, "success");
  assert.equal((await store.getTask(task))!.outcomeAt, 300);
});

test("cancelled ledger writes cannot produce a false load while waiting for SQLite ownership", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [candidate] });
  const db = await openSqlite(store.file, () => ensurePrivateDirectory(f.root));
  db.exec("BEGIN IMMEDIATE");
  const controller = new AbortController();
  const pending = store.recordLoad({ ...skill, source: "automatic" }, controller.signal);
  await delay(30); controller.abort(); db.exec("ROLLBACK"); db.close();
  await assert.rejects(pending, /abort/i);
  assert.equal((await store.getTask(task))!.skills[0]!.loaded, false);
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(store.recordLoad({ ...skill, source: "automatic" }, alreadyCancelled.signal), /abort/i);
});

test("only validated metadata is persisted, while unloaded feedback and malformed inputs are rejected", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [{ ...candidate, excerpt: "PRIVATE_RAW_EXCERPT" }], transcript: "PRIVATE_TASK_BODY" } as any);
  await assert.rejects(store.feedback({ ...skill, outcome: "success", source: "model" }), /loaded/i);
  await assert.rejects(store.recordUse({ ...skill, source: "model" }), /loaded/i);
  await assert.rejects(store.recordSearch({ ...task, candidates: [{ ...candidate, reasonCodes: ["PRIVATE RAW TEXT"] }] }), /reason/i);
  await assert.rejects(store.recordLoad({ ...skill, sha256: "unversioned", source: "automatic" }), /hash/i);
  await assert.rejects(store.recordLoad({ ...skill, skillId: "../escape", source: "automatic" }), /skill id/i);
  const names = await fs.readdir(path.dirname(store.file));
  for (const name of names.filter((name) => name.startsWith("reuse.sqlite"))) assert.doesNotMatch((await fs.readFile(path.join(path.dirname(store.file), name))).toString(), /PRIVATE_RAW|PRIVATE_TASK/);
});

test("compaction keeps minimal deduplication and feedback tombstones while preserving pending details", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [candidate], policyVersion: "reuse-v1" });
  await store.recordLoad({ ...skill, source: "automatic" });
  await store.feedback({ ...skill, outcome: "success", source: "user" });
  await store.finishTask({ ...task, outcome: "success" });
  await store.recordSearch({ sessionId: task.sessionId, anchorId: "pending-task", candidates: [candidate] });
  const before = await store.history();
  await delay(2);
  assert.equal(await store.compact({ keepRecentTasks: 0, olderThanDays: 0 }), 1);
  const compacted = (await store.getTask(task))!;
  assert.equal(compacted.compacted, true); assert.equal(compacted.policyVersion, undefined); assert.equal(compacted.skills[0]!.score, undefined); assert.deepEqual(compacted.skills[0]!.reasonCodes, []);
  assert.equal((await store.getTask({ sessionId: task.sessionId, anchorId: "pending-task" }))!.compacted, false);
  await store.recordSearch({ ...task, candidates: [candidate], policyVersion: "reuse-v1" });
  await store.recordLoad({ ...skill, source: "automatic" });
  assert.deepEqual(await store.history(), before);
  assert.equal((await store.getTask(task))!.skills[0]!.score, undefined);
});

test("concurrent processes cannot multiply one task and skill version's feedback", async (t) => {
  const f = await fixture(t), store = f.store();
  await store.recordSearch({ ...task, candidates: [candidate] });
  const script = `
    const {ReuseStore}=await import(${JSON.stringify(new URL("../dist/reuse-store.js", import.meta.url).href)});
    const store=new ReuseStore(${JSON.stringify(f.root)});
    for(let i=0;i<5;i++){
      await store.recordLoad({...${JSON.stringify(skill)},source:'automatic'});
      await store.feedback({...${JSON.stringify(skill)},outcome:'success',source:'model'});
    }
    await store.close();`;
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  await Promise.all([run(), run()]);
  const stats = (await store.history())[0]!;
  assert.equal(stats.loaded, 1); assert.equal(stats.reportedUsed, 1); assert.equal(stats.modelFeedback.success, 1);
});
