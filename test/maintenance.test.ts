import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { cleanEvidence } from "../dist/maintenance.js";
import { QueueStore } from "../dist/jobs.js";
import { SkillStore } from "../dist/skills.js";

test("evidence cleanup previews and clears terminal payloads while preserving ownership and pending work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-clean-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const queue = new QueueStore(root);
  const snapshot = { sessionId: "s", directory: root, terminal: "success", messages: [] };
  for (const [id, status] of [["completed", "saved"], ["waiting", "pending"], ["draft", "draft"]]) {
    await queue.upsert({ id, sessionId: "s", fingerprint: id, status, snapshot, attempts: 0, createdAt: 1, updatedAt: 1, nextRunAt: 1 });
  }
  await queue.close();
  const dir = path.join(root, ".opencode/autoskill/provenance/owned");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SOURCE.json");
  const body = "---\nname: owned\nmetadata:\n  autoskill: true\n---\n# Owned\n";
  const sha256 = createHash("sha256").update(body).digest("hex");
  const skillDir = path.join(root, ".opencode/skills/owned"); await fs.mkdir(skillDir, { recursive: true }); await fs.writeFile(path.join(skillDir, "SKILL.md"), body);
  const originalSource = { skillId: "owned", skillSha256: sha256, taskId: "completed", createdAt: "2020-01-01", evidence: [{ excerpt: "retained business evidence" }] };
  await fs.writeFile(file, JSON.stringify(originalSource));
  await fs.writeFile(path.join(dir, "PUBLISH.json"), JSON.stringify({ nextHash: sha256, source: originalSource }));
  const before = await fs.readFile(file, "utf8");
  assert.deepEqual(await cleanEvidence(root, { olderThanDays: 1, dryRun: true }), { dryRun: true, jobs: 1, files: 2 });
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(await cleanEvidence(root, { olderThanDays: 1 }), { dryRun: false, jobs: 1, files: 2 });
  await new SkillStore(root).list(); // Crash recovery must not resurrect cleaned evidence.
  const source = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(source.evidence, []); assert.equal(source.skillSha256, sha256); assert.equal(source.taskId, "completed");
  const reopened = new QueueStore(root);
  try {
    const state = await reopened.read();
    assert.equal(state.jobs.completed.snapshot, undefined);
    assert.ok(state.jobs.waiting.snapshot); assert.ok(state.jobs.draft.snapshot);
    assert.equal(state.jobs.completed.fingerprint, "completed");
  } finally { await reopened.close(); }
});
