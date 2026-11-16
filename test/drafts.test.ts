import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DraftStore } from "../dist/drafts.js";
import { QueueStore } from "../dist/jobs.js";
import type { DraftRecord } from "../src/drafts.ts";
import { withAssessment } from "./helpers/assessment.ts";

async function project(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-draft-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function draft(id = "migration-retry"): DraftRecord {
  const procedure = "Observed a transient lock and retried with a bounded delay.";
  const verification = "Independent regression command completed successfully.";
  return {
    id,
    decision: withAssessment({ action: "create", reason: "Repeated and verified workflow", taskCompleted: true, reusable: true, confidence: 0.97,
      skill: { id, name: "Migration retry", description: "Retry transient migration locks safely.", whenToUse: ["A migration encounters a transient lock."], prerequisites: [],
        steps: ["Capture the lock error.", "Retry using bounded backoff."], pitfalls: ["Do not hide permanent errors."], verification: ["Run the lock regression command."] },
      evidence: [{ toolCallId: "tool-procedure", excerpt: procedure, supports: "procedure" }, { toolCallId: "tool-verification", excerpt: verification, supports: "verification" }] }),
    provenance: { sessionId: "session-1", fingerprint: `fingerprint-${id}`, messageIds: ["message-1"], evidence: [], createdAt: new Date().toISOString() },
    evidence: [{ id: "tool-procedure", name: "terminal", status: "completed", input: "retry", output: procedure }, { id: "tool-verification", name: "test", status: "completed", input: "run regression", output: verification }],
  };
}

test("DraftStore creates private drafts and exposes summaries", async (t) => {
  const root = await project(t), store = new DraftStore(root), record = await store.create(draft());
  assert.equal(record.id, "migration-retry");
  assert.equal((await store.list())[0]!.skillId, "migration-retry");
  assert.equal((await store.inspect("migration-retry")).decision.skill!.steps.length, 2);
  assert.match(await fs.readFile(path.join(root, ".opencode/autoskill/drafts/migration-retry.json"), "utf8"), /fingerprint-migration-retry/);
});

test("recreating an identical draft is idempotent and cannot replace a different candidate", async t => {
  const root = await project(t), store = new DraftStore(root), input = draft();
  const first = await store.create(input);
  assert.deepEqual(await store.create(structuredClone(input)), first);
  const different = structuredClone(input); different.decision.skill!.name = "A conflicting candidate";
  await assert.rejects(store.create(different), /different evidence or content/);
  const changedEvidence = structuredClone(input); changedEvidence.evidence[0]!.output += " An unreviewed extra result.";
  await assert.rejects(store.create(changedEvidence), /different evidence or content/);
  assert.equal((await store.inspect(input.id)).decision.skill!.name, input.decision.skill!.name);
});

test("publishing a draft updates an existing queue job and is idempotent", async (t) => {
  const root = await project(t), store = new DraftStore(root), record = draft();
  const queue = new QueueStore(root);
  await queue.upsert({ id: record.id, sessionId: "session-1", fingerprint: record.provenance.fingerprint, status: "draft", attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: Date.now() });
  await queue.close();
  const saved = await store.publish((await store.create(record)).id);
  assert.equal(saved.jobId, record.id);
  assert.equal((await store.list())[0]!.status, "published");
  const inspectQueue = new QueueStore(root); const state = await inspectQueue.read(); await inspectQueue.close();
  assert.equal(state.jobs[record.id]!.status, "saved");
  const again = await store.publish(record.id);
  assert.equal(again.sha256, saved.sha256);
});

test("discard marks a matching queue job skipped and does not touch skills", async (t) => {
  const root = await project(t), store = new DraftStore(root), record = draft("discard-me");
  const queue = new QueueStore(root);
  await queue.upsert({ id: record.id, sessionId: "session-1", fingerprint: record.provenance.fingerprint, status: "draft", attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: Date.now() });
  await queue.close();
  await store.create(record); await store.discard(record.id);
  assert.equal((await store.list())[0]!.status, "discarded");
  const inspectQueue = new QueueStore(root); const state = await inspectQueue.read(); await inspectQueue.close();
  assert.equal(state.jobs[record.id]!.status, "skipped");
  assert.equal((await fs.readdir(path.join(root, ".opencode", "skills"), { withFileTypes: true }).catch(() => [])).length, 0);
});

