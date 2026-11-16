import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli } from "../bin/autoskill.mjs";
import { SkillStore } from "../dist/skills.js";
import { QueueStore } from "../dist/jobs.js";
import { DraftStore } from "../dist/drafts.js";
import type { ReviewDecision, ReviewProvenance } from "../src/types.ts";
import { assessmentFor } from "./helpers/assessment.ts";

const provenance: ReviewProvenance = { sessionId: "test-session", fingerprint: "test-fingerprint", messageIds: ["user", "assistant"], createdAt: new Date().toISOString(), evidence: [] };
function decision(id = "database-retry", action: "create" | "update" = "create"): ReviewDecision {
  return { action, taskCompleted: true, reusable: true, confidence: 0.96, reason: "Verified procedure", skill: { id, name: "数据库锁重试", description: `Use for transient database locks (${id}).`, whenToUse: ["Migration meets a transient lock"], prerequisites: [], steps: ["Inspect the lock", "Use bounded retries"], pitfalls: [], verification: ["Run the lock regression fixture"] }, evidence: [] };
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-cli-life-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-cli-life-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const store = new SkillStore(root);
  await store.save(decision(), provenance);
  const invoke = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCli([...args, "--project", root], { out(value: string) { output.push(value); }, error() {} });
    return { code, value: JSON.parse(output.at(-1)!) };
  };
  return { root, store, invoke };
}

test("CLI inspects lifecycle, previews pin, preserves pinned skills during prune and restores archive", async t => {
  const { invoke } = await fixture(t);
  assert.equal((await invoke(["skills", "list"])).value.skills[0].title, "数据库锁重试");
  assert.equal((await invoke(["skills", "list"])).value.skills[0].content, undefined);
  const preview = (await invoke(["skills", "pin", "database-retry", "--dry-run"])).value;
  assert.equal(preview.dryRun, true);
  assert.equal((await invoke(["skills", "inspect", "database-retry"])).value.skill.pinned, false);
  assert.equal((await invoke(["pin", "database-retry"])).value.skill.pinned, true);
  assert.deepEqual((await invoke(["prune", "--keep", "0", "--dry-run"])).value.archived, []);
  await invoke(["unpin", "database-retry"]);
  assert.equal((await invoke(["archive", "database-retry"])).value.skill.archived, true);
  assert.equal((await invoke(["restore", "database-retry"])).value.skill.archived, false);
});

test("CLI rollback uses a retained version and explicit adoption protects manual changes", async t => {
  const { root, store, invoke } = await fixture(t);
  const initial = await store.inspect("database-retry");
  const body = await fs.readFile(initial.skill.path, "utf8");
  const changed = decision("database-retry", "update");
  changed.skill!.steps.push("Stop after the retry budget");
  await store.save(changed, provenance, { expectedPreviousHash: initial.skill.sha256 });
  const version = (await invoke(["inspect", "database-retry"])).value.versions[0];
  await invoke(["rollback", "database-retry", "--version", version]);
  assert.equal(await fs.readFile(initial.skill.path, "utf8"), body);
  await fs.appendFile(initial.skill.path, "\nManual correction that must survive.\n");
  await assert.rejects(invoke(["rollback", "database-retry"]), /manual|managed|rollback/i);
  assert.equal((await invoke(["adopt", "database-retry", "--dry-run"])).value.current.ownership, "user-modified");
  assert.equal((await invoke(["adopt", "database-retry"])).value.skill.ownership, "managed");
  assert.match(await fs.readFile(path.join(root, ".opencode/skills/database-retry/SKILL.md"), "utf8"), /Manual correction/);
});

test("CLI feedback records outcomes and prune only archives eligible generated skills", async t => {
  const { store, invoke } = await fixture(t);
  const feedback = (await invoke(["feedback", "database-retry", "--outcome", "success", "--notes", "Fixture worked"])).value;
  assert.equal(feedback.skill.feedback.success, 1);
  await assert.rejects(invoke(["feedback", "database-retry", "--dry-run"]), /outcome/);
  await store.save(decision("second-workflow"), provenance);
  await invoke(["pin", "second-workflow"]);
  const preview = (await invoke(["skills", "prune", "--keep", "0", "--dry-run"])).value;
  assert.deepEqual(preview.archived, ["database-retry"]);
  assert.equal((await store.inspect("database-retry")).skill.archived, false);
  await invoke(["prune", "--keep", "0"]);
  assert.equal((await store.inspect("database-retry")).skill.archived, true);
  assert.equal((await store.inspect("second-workflow")).skill.archived, false);
});

test("runtime status omits transcript payload and recover requeues an expired owner", async t => {
  const { root, invoke } = await fixture(t);
  const queue = new QueueStore(root);
  try {
    await queue.transaction((state) => {
      state.metrics = { candidate_saved: 3 };
      state.lastDecision = { at: Date.now(), sessionId: "session-test", reasonCode: "candidate_saved", result: { status: "saved", reason: "Saved", skillId: "database-retry" } };
      state.recent.push({ at: new Date().toISOString(), sessionId: "session-test", reasonCode: "candidate_saved", result: { status: "saved", reason: "Saved" } });
      state.jobs["job-recover"] = { id: "job-recover", sessionId: "session-test", fingerprint: "fingerprint", status: "running", attempts: 1,
        createdAt: Date.now() - 10_000, updatedAt: Date.now() - 5_000, nextRunAt: 0, lease: { token: "expired", pid: 2_147_483_647, expiresAt: 0 },
        reasonCode: "WAITING", snapshot: { sessionId: "session-test", directory: root, terminal: "success", messages: [{ id: "u", role: "user", text: "PRIVATE_TRANSCRIPT_MARKER", tools: [] }] } };
    });
    const status = (await invoke(["status", "--runtime"])).value;
    assert.equal(status.runtime.queue.running, 1);
    assert.equal(status.runtime.jobs[0].reasonCode, "WAITING");
    assert.equal(status.runtime.metrics.candidate_saved, 3);
    assert.equal(status.runtime.lastDecision.reasonCode, "candidate_saved");
    assert.equal(status.runtime.recent[0].reasonCode, "candidate_saved");
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_TRANSCRIPT_MARKER|snapshot/);
    assert.equal((await invoke(["recover", "--dry-run"])).value.dryRun, true);
    assert.equal((await queue.read()).jobs["job-recover"].status, "running");
    assert.equal((await invoke(["recover"])).value.recovered, 1);
    assert.equal((await queue.read()).jobs["job-recover"].status, "retry");
  } finally { await queue.close(); }
});

test("CLI previews, publishes, inspects and discards private draft candidates", async t => {
  const { root, store, invoke } = await fixture(t);
  const drafts = new DraftStore(root);
  const procedure = "Cache cleanup used bounded batches and resumed from the committed marker.";
  const verification = "Independent cache consistency check completed successfully with no missing entries.";
  const candidate = decision("cache-cleanup");
  candidate.skill!.name = "分批清理缓存";
  candidate.skill!.description = "Use for resumable batched cache cleanup without missing entries.";
  candidate.skill!.steps = ["Delete one bounded batch", "Commit a resume marker before the next batch"];
  candidate.evidence = [{ toolCallId: "p", excerpt: procedure, supports: "procedure" }, { toolCallId: "v", excerpt: verification, supports: "verification" }];
  candidate.assessment = assessmentFor(candidate.evidence);
  const evidence = [{ id: "p", name: "terminal", status: "completed" as const, output: procedure }, { id: "v", name: "test", status: "completed" as const, output: verification }];
  await drafts.create({ id: "publish-candidate", decision: candidate, provenance, evidence });
  await drafts.create({ id: "discard-candidate", decision: { ...candidate, skill: { ...candidate.skill!, id: "cache-cleanup-discard" } }, provenance, evidence });
  const listed = (await invoke(["drafts", "list"])).value.drafts;
  assert.equal(listed.length, 2);
  assert.equal(listed[0].decision, undefined);
  assert.equal((await invoke(["drafts", "inspect", "publish-candidate"])).value.decision.skill.id, "cache-cleanup");
  assert.equal((await invoke(["drafts", "publish", "publish-candidate", "--dry-run"])).value.dryRun, true);
  await assert.rejects(store.inspect("cache-cleanup"), /does not exist/);
  assert.equal((await invoke(["drafts", "publish", "publish-candidate"])).value.result.id, "cache-cleanup");
  assert.equal((await invoke(["drafts", "inspect", "publish-candidate"])).value.status, "published");
  assert.equal((await invoke(["drafts", "discard", "discard-candidate", "--dry-run"])).value.dryRun, true);
  assert.equal((await drafts.list()).find(item => item.id === "discard-candidate")!.status, "draft");
  assert.equal((await invoke(["drafts", "discard", "discard-candidate"])).value.result.status, "discarded");
  assert.equal((await store.inspect("cache-cleanup")).skill.ownership, "managed");
  await assert.rejects(store.inspect("cache-cleanup-discard"), /does not exist/);
  await assert.rejects(runCli(["drafts", "list", "--global"]), /项目数据/);
});

test("CLI evidence cleanup previews counts and preserves ownership and pending work", async t => {
  const { root, store, invoke } = await fixture(t);
  await store.save(decision("cleanup-source"), { ...provenance, createdAt: "2020-01-01T00:00:00.000Z", evidence: [{ toolCallId: "old-tool", excerpt: "Private historical execution evidence", supports: "procedure" }] });
  const sourcePath = path.join(root, ".opencode/autoskill/provenance/cleanup-source/SOURCE.json");
  const before = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const queue = new QueueStore(root);
  try {
    await queue.transaction(state => {
      for (const status of ["saved", "pending"] as const) state.jobs[`cleanup-${status}`] = {
        id: `cleanup-${status}`, sessionId: "cleanup-session", fingerprint: `fingerprint-${status}`, status, attempts: 0, createdAt: 0, updatedAt: 0, nextRunAt: 0,
        snapshot: { sessionId: "cleanup-session", directory: root, terminal: "success", messages: [] },
      };
    });
    const preview = (await invoke(["clean", "--older-than", "0", "--dry-run"])).value;
    assert.deepEqual(preview, { dryRun: true, jobs: 1, files: 1 });
    assert.ok((await queue.read()).jobs["cleanup-saved"]!.snapshot);
    assert.equal(JSON.parse(await fs.readFile(sourcePath, "utf8")).evidence.length, 1);
    const cleaned = (await invoke(["clean", "--older-than", "0"])).value;
    assert.deepEqual(cleaned, { dryRun: false, jobs: 1, files: 1 });
    const state = await queue.read();
    assert.equal(state.jobs["cleanup-saved"]!.snapshot, undefined);
    assert.ok(state.jobs["cleanup-pending"]!.snapshot);
    const after = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    assert.equal(after.skillSha256, before.skillSha256);
    assert.deepEqual(after.evidence, []);
    assert.equal((await store.inspect("cleanup-source")).skill.ownership, "managed");
    await assert.rejects(invoke(["clean", "--older-than", "-1"]), /非负天数/);
    await assert.rejects(runCli(["clean", "--global"]), /项目数据/);
  } finally { await queue.close(); }
});
