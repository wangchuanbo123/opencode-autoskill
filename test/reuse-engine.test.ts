import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReuseEngine } from "../dist/reuse.js";
import { SkillStore } from "../dist/skills.js";
import { readOptions } from "../dist/config.js";
import { detectReuseEnvironment } from "../dist/reuse-environment.js";
import { runCli } from "../bin/autoskill.mjs";
import type { EnginePort, ReviewDecision, TaskSnapshot } from "../src/types.ts";
import { digest } from "../dist/tasks.js";
import { AutoSkillEngine } from "../dist/engine.js";

const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/reuse.json", import.meta.url), "utf8"));
async function fixture(t: test.TestContext, options: Record<string, unknown> = {}, ids = ["migration-lock-retry", "tenant-invoice-cache"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-reuse-engine-"));
  const store = new SkillStore(root);
  for (const id of ids) {
    const data = corpus.skills.find((skill: any) => skill.id === id);
    await store.save({ action: "create", reason: "Trusted test fixture", taskCompleted: true, reusable: true, confidence: 0.99,
      skill: { ...data, pitfalls: [], verification: ["Run an independent targeted regression."] } } as ReviewDecision,
      { sessionId: "source", fingerprint: `source-${id}`, messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  }
  const port: EnginePort = { root, snapshot: async () => { throw new Error("not used"); }, generate: async () => { throw new Error("retrieval must not call a model"); },
    listSkills: async () => (await store.list()).map((skill) => ({ ...skill, id: `host-${skill.id}` })), reloadSkills: async () => {}, log: () => {} };
  const engines: ReuseEngine[] = [];
  const make = () => { const engine = new ReuseEngine(root, readOptions(options), port); engines.push(engine); return engine; };
  const engine = make();
  t.after(async () => { await Promise.all(engines.map((entry) => entry.close())); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-reuse-engine-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const prepare = (messageId = "user-a", text = "Recover concurrent database migration lock with bounded retry") => engine.prepare({ sessionId: "session-a", messageId, text });
  const cli = async (args: string[]) => { const output: string[] = []; const code = await runCli([...args, "--project", root], { out(value: string) { output.push(value); }, error() {} });
    return { code, data: JSON.parse(output.at(-1)!) }; };
  return { root, store, engine, port, prepare, make, cli };
}

test("new tasks search all trusted skills but load bounded relevant instructions without model calls", async (t) => {
  const f = await fixture(t); await f.prepare();
  const context = await f.engine.context("session-a", undefined, "user-a");
  assert.ok(context!.candidateIds.includes("migration-lock-retry"));
  assert.match(context!.text, /Retry transient locks within a deadline/);
  assert.doesNotMatch(context!.text, /tenant-invoice-cache/);
  assert.ok(context!.text.length <= readOptions().reuseMaxContextChars);
  assert.ok(context!.catalog.some((skill) => skill.hostIds?.includes("host-migration-lock-retry")));
  const task = await f.engine.ledger.getTask({ sessionId: "session-a", anchorId: "user-a" });
  assert.equal(task!.skills.find((skill) => skill.skillId === "migration-lock-retry")!.loaded, true);
  assert.equal(task!.skills[0]!.used, false);
  assert.deepEqual((await f.engine.ledger.history("migration-lock-retry"))[0]!.userFeedback, { success: 0, failure: 0 });
});

test("queued admission cannot change active task selection, and later tasks do not inherit prior bodies", async (t) => {
  const f = await fixture(t); await f.prepare(); await f.engine.context("session-a", undefined, "user-a");
  await f.prepare("user-b", "Isolate tenant invoice cache collision across tenants");
  assert.equal((await f.engine.load({ sessionId: "session-a", skillId: "tenant-invoice-cache" }) as any).reasonCode, "not_in_current_shortlist");
  assert.doesNotMatch((await f.engine.context("session-a", undefined, "user-a"))!.text, /tenant-invoice-cache/);
  const later = await f.engine.context("session-a", undefined, "user-b");
  assert.match(later!.text, /tenant-invoice-cache/); assert.doesNotMatch(later!.text, /migration-lock-retry/);
});

test("same-task retries and process restart keep loaded versions deduplicated without retaining the task text", async (t) => {
  const f = await fixture(t); await f.prepare(); await f.engine.context("session-a", undefined, "user-a"); await f.prepare();
  await f.engine.context("session-a", undefined, "user-a");
  const reopened = f.make(); const context = await reopened.context("session-a", undefined, "user-a"); assert.match(context!.text, /migration-lock-retry/);
  assert.equal((await reopened.ledger.history("migration-lock-retry"))[0]!.loaded, 1);
  assert.doesNotMatch(JSON.stringify(await reopened.status()), /Recover concurrent database/);
});

test("uncertain prerequisites and disabled automatic loading remain summaries until explicit model selection", async (t) => {
  const f = await fixture(t, { reuseAutoLoadLimit: 0 }); await f.prepare();
  const before = await f.engine.context("session-a", undefined, "user-a"); assert.doesNotMatch(before!.text, /Retry transient locks within a deadline/);
  assert.equal((await f.engine.load({ sessionId: "session-a", skillId: "migration-lock-retry" }) as any).status, "loaded");
  assert.match((await f.engine.context("session-a", undefined, "user-a"))!.text, /Retry transient locks within a deadline/);
  const task = await f.engine.ledger.getTask({ sessionId: "session-a", anchorId: "user-a" }); assert.equal(task!.skills[0]!.loadSource, "explicit");
});

test("changed, archived and over-budget bodies are not injected or silently truncated", async (t) => {
  const f = await fixture(t, { reuseMaxSkillChars: 500 }); await f.prepare();
  assert.doesNotMatch((await f.engine.context("session-a", undefined, "user-a"))!.text, /Retry transient locks within a deadline/);
  assert.equal((await f.engine.load({ sessionId: "session-a", skillId: "migration-lock-retry" }) as any).status, "skipped");
  const g = await fixture(t); await g.prepare(); const skill = (await g.store.inspect("migration-lock-retry")).skill;
  await fs.appendFile(skill.path, "\nManual changes must not be automatically loaded.\n");
  assert.doesNotMatch((await g.engine.context("session-a", undefined, "user-a"))!.text, /Retry transient locks within a deadline/);
  assert.equal((await g.engine.load({ sessionId: "session-a", skillId: "migration-lock-retry" }) as any).status, "skipped");
});

test("task outcome and loading do not become success feedback; model and user reports remain separate", async (t) => {
  const f = await fixture(t); await f.prepare(); await f.engine.context("session-a", undefined, "user-a");
  const snapshot: TaskSnapshot = { sessionId: "session-a", directory: f.root, terminal: "success", messages: [
    { id: "user-a", role: "user", text: "Recover concurrent database migration lock with bounded retry", tools: [], createdAt: 1 }, { id: "a", role: "assistant", text: "Done", tools: [], completedAt: 2 } ] };
  await f.engine.finish(snapshot); let stats = (await f.engine.ledger.history("migration-lock-retry"))[0]!;
  assert.equal(stats.taskOutcomes.success, 1); assert.equal(stats.feedback.success, 0); assert.equal(stats.reportedUsed, 0);
  assert.equal((await f.engine.feedback({ sessionId: "session-a", skillId: "migration-lock-retry", used: false, outcome: "success" }) as any).reasonCode, "application_not_reported");
  await f.engine.feedback({ sessionId: "session-a", skillId: "migration-lock-retry", used: true, outcome: "success" });
  await f.cli(["reuse", "feedback", "migration-lock-retry", "--session", "session-a", "--task", "user-a", "--outcome", "failure"]);
  stats = (await f.engine.ledger.history("migration-lock-retry"))[0]!;
  assert.deepEqual(stats.userFeedback, { success: 0, failure: 1 }); assert.deepEqual(stats.modelFeedback, { success: 1, failure: 0 });
  assert.equal((await f.cli(["reuse", "status"])).data.searchedTasks, 1);
  assert.equal((await f.cli(["reuse", "history", "migration-lock-retry"])).data.history[0].reportedUsed, 1);
  await f.prepare("user-b", "Isolate tenant invoice cache collision across tenants");
  await f.engine.context("session-a", undefined, "user-b");
  const later = structuredClone(snapshot);
  later.messages.push({ id: "user-b", role: "user", text: "Isolate tenant invoice cache collision across tenants", tools: [], createdAt: 3 },
    { id: "b", role: "assistant", text: "Verified", tools: [], completedAt: 4 });
  await f.engine.finish(later);
  assert.equal((await f.engine.ledger.getTask({ sessionId: "session-a", anchorId: "user-a" }))!.outcome, "success");
});

test("refined search returns summaries and enables explicit loading for the current task", async (t) => {
  const f = await fixture(t); await f.prepare("user-a", "Investigate the performance regression"); await f.engine.context("session-a", undefined, "user-a");
  const result = await f.engine.search({ sessionId: "session-a", query: "database migration lock retry" }) as any;
  assert.ok(result.candidates.some((skill: any) => skill.id === "migration-lock-retry")); assert.ok(result.candidates.every((skill: any) => !skill.content));
  assert.equal((await f.engine.load({ sessionId: "session-a", skillId: "migration-lock-retry" }) as any).status, "loaded", "explicit refinement permits model judgment while preserving safety and constraints");
});

test("privacy, user opt-out, disabled mode and cancellation produce no loaded body", async (t) => {
  const f = await fixture(t, { sensitivePatterns: ["PrivateMarker"] });
  await f.prepare("private", "PrivateMarker database migration lock retry"); assert.equal((await f.engine.context("session-a", undefined, "private"))!.text, "");
  await f.prepare("optout", "不要使用任何已有技能，处理数据库迁移锁重试"); assert.equal((await f.engine.context("session-a", undefined, "optout"))!.text, "");
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.engine.prepare({ sessionId: "session-a", messageId: "cancelled", text: "migration lock", signal: abort.signal }));
  assert.equal(await f.engine.ledger.getTask({ sessionId: "session-a", anchorId: "cancelled" }), undefined);
  const disabled = await fixture(t, { reuseEnabled: false }); await disabled.prepare(); assert.equal(await disabled.engine.context("session-a", undefined, "user-a"), undefined);
});

test("environment discovery reads bounded project manifests without assuming subprocess runtime versions", async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "package.json"), JSON.stringify({ dependencies: { react: "19", pg: "8" }, scripts: { private: "DO_NOT_EXPOSE_SCRIPT" } }));
  const environment = await detectReuseEnvironment(f.root);
  assert.ok(environment.technologies!.includes("react")); assert.ok(environment.technologies!.includes("postgresql"));
  assert.equal(environment.runtimeVersions, undefined); assert.doesNotMatch(JSON.stringify(environment), /DO_NOT_EXPOSE_SCRIPT/);
});

test("edited messages use the exact context revision and missing context clears the previous active task", async (t) => {
  const f = await fixture(t);
  const first = "Recover concurrent database migration lock with bounded retry", second = "Isolate tenant invoice cache collision across tenants";
  await f.prepare("same-message", first); await f.prepare("same-message", second);
  const original = await f.engine.context("session-a", undefined, "same-message", digest(first));
  assert.match(original!.text, /migration-lock-retry/); assert.doesNotMatch(original!.text, /tenant-invoice-cache/);
  const edited = await f.engine.context("session-a", undefined, "same-message", digest(second));
  assert.match(edited!.text, /tenant-invoice-cache/); assert.doesNotMatch(edited!.text, /migration-lock-retry/);
  assert.equal(await f.engine.context("session-a", undefined, "missing", digest("missing")), undefined);
  assert.equal((await f.engine.load({ sessionId: "session-a", skillId: "tenant-invoice-cache" }) as any).reasonCode, "task_context_missing");
});

test("explicit opt-out, sensitive tasks and topic exclusions cannot be bypassed by search after restart", async (t) => {
  for (const text of ["Do not use any skills. Investigate migration locks", "PrivateMarker migration lock retry"]) {
    const f = await fixture(t, { sensitivePatterns: ["PrivateMarker"] }); await f.prepare("user-a", text);
    const restarted = f.make(); await restarted.context("session-a", undefined, "user-a", digest(text));
    assert.equal((await restarted.search({ sessionId: "session-a", query: "database migration lock retry" }) as any).reasonCode, "task_reuse_blocked");
    assert.equal((await restarted.load({ sessionId: "session-a", skillId: "migration-lock-retry" }) as any).status, "skipped");
  }
  const f = await fixture(t); await f.prepare("user-a", "Do not use tenant invoice cache; investigate database migration lock retry");
  const restarted = f.make(); await restarted.context("session-a", undefined, "user-a");
  const result = await restarted.search({ sessionId: "session-a", query: "tenant invoice cache collision isolation" }) as any;
  assert.ok(!result.candidates.some((skill: any) => skill.id === "tenant-invoice-cache"));
});

test("cancellation during native catalogue lookup does not record a body as loaded", async (t) => {
  const f = await fixture(t); await f.prepare();
  f.port.listSkills = async (signal) => new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  const controller = new AbortController();
  const pending = f.engine.context("session-a", controller.signal, "user-a");
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 20);
  try { await assert.rejects(pending, /cancelled/); } finally { clearTimeout(timer); }
  assert.equal((await f.engine.ledger.history("migration-lock-retry"))[0]!.loaded, 0);
});

test("quality governance previews and archives the exact failed version while preserving restore and feedback", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const anchor = `user-${index}`; await f.prepare(anchor); await f.engine.context("session-a", undefined, anchor);
    await f.cli(["reuse", "feedback", "migration-lock-retry", "--session", "session-a", "--task", anchor, "--outcome", "failure"]);
  }
  const preview = (await f.cli(["reuse", "govern"])).data; assert.equal(preview.dryRun, true);
  assert.ok(preview.plan.suggestions.some((item: any) => item.kind === "archive" && item.skillId === "migration-lock-retry"));
  assert.equal((await f.store.inspect("migration-lock-retry")).skill.archived, false);
  assert.equal((await f.cli(["reuse", "govern", "--apply"])).data.applied[0].skillId, "migration-lock-retry");
  assert.equal((await f.store.inspect("migration-lock-retry")).skill.archived, true);
  await f.cli(["skills", "restore", "migration-lock-retry"]);
  assert.equal((await f.store.inspect("migration-lock-retry")).skill.archived, false);
  assert.equal((await f.engine.ledger.history("migration-lock-retry"))[0]!.userFeedback.failure, 3);
});

test("unresponsive native bookkeeping cannot defeat the distillation deadline or engine disposal", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const snapshot: TaskSnapshot = { sessionId: "session-deadline", directory: f.root, terminal: "success", messages: [
    { id: "u", role: "user", text: "Review native skill load", tools: [] },
    { id: "a", role: "assistant", text: "Completed", tools: [{ id: "native-call", name: "skill", status: "completed", input: { id: "migration-lock-retry" }, output: "Loaded migration lock retry." }] },
  ] };
  const engine = new AutoSkillEngine({ ...f.port, options: { reviewTimeoutMs: 100, reuseTimeoutMs: 1000, globalStateDirectory: path.join(f.root, "private-global") },
    snapshot: async () => snapshot, listSkills: async () => new Promise(() => {}) });
  const started = Date.now();
  try { assert.equal((await engine.review(snapshot.sessionId, true)).reasonCode, "review_timeout"); assert.ok(Date.now() - started < 2000); }
  finally { await engine.dispose(); }
});
