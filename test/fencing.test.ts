import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AutoSkillEngine } from "../dist/engine.js";
import { SkillStore } from "../dist/skills.js";
import { QueueStore } from "../dist/jobs.js";
import { withAssessment } from "./helpers/assessment.ts";

test("a worker losing its lease during skill preparation cannot publish", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-fencing-"));
  const queue = new QueueStore(root);
  const snapshot = { sessionId: "fence", directory: root, terminal: "success", messages: [
    { id: "u", role: "user", text: "Investigate migration locks and verify the correction", tools: [] },
    { id: "a", role: "assistant", text: "Verified", tools: [
      { id: "procedure", name: "read", status: "completed", output: "Root cause: concurrent writer holds a transient lock because its transaction is unfinished; compared fixed delay versus bounded backoff and selected bounded retry to preserve the deadline." },
      { id: "check", name: "shell", status: "completed", input: { command: "npm test" }, output: "Regression tests passed with bounded retry." },
    ] },
  ] };
  const engine = new AutoSkillEngine({ root, options: { minToolCalls: 2, cooldownMs: 0, globalStateDirectory: path.join(root, "budget") },
    snapshot: async () => structuredClone(snapshot), listSkills: async () => [], reloadSkills: async () => {}, log() {},
    generate: async () => JSON.stringify(withAssessment({ action: "create", reason: "Verified reusable correction", taskCompleted: true, reusable: true, confidence: .99,
      skill: { id: "lease-protected", name: "Lease protected retry", description: "Use when correcting transient migration locks", whenToUse: ["Migration locks"], prerequisites: [], steps: ["Identify transient lock conditions", "Retry within a bounded window"], pitfalls: [], verification: ["Run regression tests"] },
      evidence: [{ toolCallId: "procedure", supports: "procedure", excerpt: "Root cause: concurrent writer holds a transient lock because its transaction is unfinished; compared fixed delay versus bounded backoff and selected bounded retry to preserve the deadline." }, { toolCallId: "check", supports: "verification", excerpt: "Regression tests passed with bounded retry." }] })),
  });
  const original = SkillStore.prototype.save;
  let reclaimed = false;
  SkillStore.prototype.save = async function (decision, provenance, options) {
    const guard = options.beforeCommit;
    return original.call(this, decision, provenance, { ...options, beforeCommit: async () => {
      await queue.transaction(state => { state.jobs[provenance.taskId].lease.expiresAt = Date.now() - 1; });
      await queue.recover();
      reclaimed = !!await queue.claim(provenance.taskId);
      await guard();
    } });
  };
  try {
    const value = await engine.review("fence");
    assert.equal(reclaimed, true); assert.equal(value.reasonCode, "lease_lost");
    await assert.rejects(fs.access(path.join(root, ".opencode/skills/lease-protected/SKILL.md")));
  } finally {
    SkillStore.prototype.save = original; await engine.dispose(); await queue.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
