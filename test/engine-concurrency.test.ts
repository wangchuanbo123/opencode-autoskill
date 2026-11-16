import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AutoSkillEngine } from "../dist/engine.js";
import { SkillStore } from "../dist/skills.js";
import { QueueStore, GlobalBudgetStore } from "../dist/jobs.js";
import { collectTasks } from "../dist/tasks.js";
import { readOptions } from "../dist/config.js";
import type { EnginePort, TaskSnapshot } from "../src/types.ts";
import { withAssessment } from "./helpers/assessment.ts";

const procedure = "Root cause: fixture version conflicts with the shared migration contract because its fields use the legacy schema. Compared replacing values versus preserving identifiers; choose a staged migration to preserve compatibility.";
const verification = "Verification passed: legacy schema migration contract preserves record identifiers and compatibility.";

async function fixture(t: test.TestContext, count = 1, cooldownMs = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-concurrency-"));
  const options = { minToolCalls: 2, cooldownMs, globalStateDirectory: path.join(root, "budget") };
  const snapshot: TaskSnapshot = { sessionId: "session", directory: root, terminal: "success", model: { providerID: "local", id: "mock" },
    messages: Array.from({ length: count }, (_, index) => [
      { id: `user-${index}`, role: "user" as const, text: `Implement and verify reusable fixture ${index}.`, tools: [] },
      { id: `assistant-${index}`, role: "assistant" as const, text: "Verified fixture.", tools: [
        { id: `procedure-${index}`, name: "read", status: "completed" as const, input: {}, output: procedure },
        { id: `verification-${index}`, name: "test", status: "completed" as const, input: {}, output: verification },
      ] },
    ]).flat() };
  let calls = 0;
  const port: EnginePort = { root, options, snapshot: async () => structuredClone(snapshot), listSkills: async () => [], reloadSkills: async () => {}, log() {},
    generate: async () => { calls++; return JSON.stringify({ action: "skip", reason: "No new reusable procedure.", taskCompleted: true, reusable: false, confidence: .99 }); } };
  const engines: AutoSkillEngine[] = [];
  const queue = new QueueStore(root);
  t.after(async () => {
    await Promise.all(engines.map((engine) => engine.dispose())); await queue.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-concurrency-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, queue, snapshot, options, port, get calls() { return calls; },
    engine() { const engine = new AutoSkillEngine(port); engines.push(engine); return engine; } };
}

test("live worker reconciles committed Markdown after a queue failure without calling the model again", async (t) => {
  const f = await fixture(t);
  let reviewCalls = 0;
  f.port.generate = async () => {
    reviewCalls++;
    return JSON.stringify(withAssessment({ action: "create", reason: "Verified reusable fixture workflow.", taskCompleted: true, reusable: true, confidence: .99,
      skill: { id: "committed-workflow", name: "Committed workflow", description: "Use when verifying the isolated fixture.",
        whenToUse: ["When verifying a fixture."], prerequisites: ["A fixture is available."], steps: ["Read the fixture.", "Run independent verification."],
        pitfalls: ["Keep independent checks."], verification: ["Confirm verification passed."] },
      evidence: [{ toolCallId: "procedure-0", excerpt: procedure, supports: "procedure" }, { toolCallId: "verification-0", excerpt: verification, supports: "verification" }] }));
  };
  const engine = f.engine();
  const originalSave = SkillStore.prototype.save;
  let injected = false;
  SkillStore.prototype.save = async function (...args) {
    const saved = await originalSave.apply(this, args);
    // The first queue update after save is deliberately unavailable, after the
    // Markdown and private source have already reached their commit point.
    const internalQueue = (engine as any).queue as QueueStore;
    const originalTransaction = internalQueue.transaction.bind(internalQueue);
    internalQueue.transaction = async () => {
      injected = true; internalQueue.transaction = originalTransaction;
      throw new Error("Simulated SQLite I/O failure after Markdown publication.");
    };
    return saved;
  };
  try { assert.equal((await engine.review("session")).status, "saved"); }
  finally { SkillStore.prototype.save = originalSave; }
  clearTimeout((engine as any).timer);
  assert.equal(injected, true);
  let savedId = "";
  await f.queue.transaction((state) => {
    const job = Object.values(state.jobs).find((job) => job.snapshot)!;
    savedId = job.id; assert.equal(job.status, "running"); assert.equal(job.publication?.stage, "prepared");
    job.lease!.expiresAt = Date.now() - 1;
  });
  await (engine as any).drain();
  const state = await f.queue.read();
  assert.equal(state.jobs[savedId].status, "saved");
  assert.equal(state.jobs[savedId].publication?.stage, "committed");
  assert.equal(state.jobs[savedId].result?.reasonCode, "publication_recovered");
  assert.equal(reviewCalls, 1);
});

test("two workers racing across global reservation still enforce the session cooldown", async (t) => {
  const f = await fixture(t, 2, 60_000), first = f.engine(), second = f.engine();
  await Promise.all([first.status(), second.status()]);
  clearTimeout((first as any).timer); clearTimeout((second as any).timer);
  const packets = collectTasks(f.snapshot, readOptions(f.options), f.root);
  for (const packet of packets) await f.queue.upsert({ id: packet.id, sessionId: "session", fingerprint: packet.fingerprint, taskId: packet.taskId,
    snapshot: packet.snapshot, status: "pending", attempts: 0, createdAt: 1, updatedAt: 1, nextRunAt: 0 });
  const originalReserve = GlobalBudgetStore.prototype.reserve;
  let reservations = 0, release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  GlobalBudgetStore.prototype.reserve = async function (...args) {
    if (++reservations === 2) release();
    await barrier;
    return originalReserve.apply(this, args);
  };
  let results;
  try {
    // Separate worker entry points model independent host processes, each
    // already holding a different durable task from the same session.
    results = await Promise.all([first, second].map((engine, index) => (engine as any).start(packets[index].id, new AbortController(), false)));
  } finally { GlobalBudgetStore.prototype.reserve = originalReserve; }
  assert.equal(reservations, 2);
  assert.equal(f.calls, 1);
  assert.equal(results.filter((result) => result.reasonCode === "model_skipped").length, 1);
  const waiting = results.find((result) => result.reasonCode === "session_cooldown");
  assert.equal(waiting.status, "queued"); assert.ok(waiting.nextRunAt > Date.now());
  const state = await f.queue.read();
  assert.equal(state.reviews, 1);
  assert.equal(Object.values(state.jobs).filter((job) => job.status === "retry" && job.reasonCode === "session_cooldown").length, 1);
});
