import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SkillStore } from "../dist/skills.js";
import { planReuseGovernance, applyReuseGovernance } from "../dist/reuse-governance.js";
import type { ExistingSkill, ReviewDecision, ReviewProvenance } from "../src/types.ts";
import type { ReuseSkillStats } from "../src/reuse-store.ts";

const now = Date.parse("2026-11-13T00:00:00.000Z");
const provenance: ReviewProvenance = { sessionId: "governance-session", fingerprint: "f".repeat(64), messageIds: ["u"], evidence: [], createdAt: "2026-01-01T00:00:00.000Z" };
function decision(id: string, title = "Database lock recovery"): ReviewDecision {
  return { action: "create", reason: "verified", taskCompleted: true, reusable: true, confidence: .95,
    skill: { id, name: title, description: "Use for transient database migration locks.", whenToUse: ["A transient migration lock occurs."], prerequisites: [],
      steps: ["Inspect the lock owner and transaction state.", "Use bounded backoff and verify the migration regression."], pitfalls: ["Do not retry permanent schema errors."], verification: ["Run the migration lock regression."] }, evidence: [] };
}
function stat(skill: ExistingSkill, feedback: ReuseSkillStats["userFeedback"], lastLoadedAt = now): ReuseSkillStats {
  return { skillId: skill.id, sha256: skill.sha256!, offered: 3, loaded: 3, nativeLoaded: 0, reportedUsed: 3,
    feedback: { success: feedback.success, failure: feedback.failure, unknown: 0 }, userFeedback: feedback, modelFeedback: { success: 0, failure: 0 },
    taskOutcomes: { success: 0, failure: 0, interrupted: 0, unknown: 0 }, lastLoadedAt };
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-governance-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-governance-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const store = new SkillStore(root);
  const save = async (id: string, title?: string) => store.save(decision(id, title), provenance);
  return { root, store, save };
}

test("repeated explicit user failures suggest archiving only the current unpinned managed version", async (t) => {
  const f = await fixture(t), saved = await f.save("bad-lock"), skill = (await f.store.list())[0]!;
  const plan = planReuseGovernance([skill], [stat(skill, { success: 1, failure: 3 })], { now });
  assert.equal(plan.suggestions.length, 1); assert.equal(plan.suggestions[0]!.kind, "archive");
  assert.deepEqual(plan.suggestions[0]!.reasonCodes, ["repeated_user_failures"]);
  const applied = await applyReuseGovernance(f.root, plan, { dryRun: true });
  assert.deepEqual(applied.applied, [{ skillId: "bad-lock", action: "archive" }]);
  assert.equal((await f.store.inspect("bad-lock")).skill.archived, false);
  assert.equal(saved.sha256, skill.sha256);
});

test("stale skills with one explicit user failure are candidates; model failure alone is insufficient", async (t) => {
  const f = await fixture(t), saved = await f.save("stale-lock"), skill = (await f.store.list())[0]!;
  const old = { ...skill, lastUsedAt: new Date(now - 181 * 86_400_000).toISOString() };
  const modelOnly = stat(old, { success: 0, failure: 0 }); modelOnly.modelFeedback = { success: 0, failure: 3 };
  assert.equal(planReuseGovernance([old], [modelOnly], { now }).suggestions.length, 0);
  const suggestion = planReuseGovernance([old], [stat(old, { success: 0, failure: 1 }, now - 181 * 86_400_000)], { now }).suggestions[0]!;
  assert.deepEqual(suggestion.reasonCodes, ["stale_with_user_failure"]);
});

test("pinned, user-modified, archived and old-hash skills are never archive recommendations", () => {
  const base: ExistingSkill = { id: "safe", name: "Safe", description: "Safe", path: "safe", managed: true, ownership: "managed", pinned: false, archived: false, sha256: "c".repeat(64), feedback: { success: 0, failure: 0 } };
  const stats = [stat(base, { success: 0, failure: 4 })];
  const variants = [{ ...base, pinned: true }, { ...base, ownership: "user-modified" as const, managed: false }, { ...base, archived: true }, { ...base, sha256: "d".repeat(64) }];
  for (const variant of variants) assert.equal(planReuseGovernance([variant], stats, { now }).suggestions.filter((item) => item.kind === "archive").length, 0);
});

test("duplicate procedures produce advisory canonical aliases and never merge or rewrite bodies", async (t) => {
  const f = await fixture(t), first = await f.save("lock-a", "Lock recovery A"), second = await f.save("lock-b", "Lock recovery B");
  let skills = await f.store.list();
  const canonical = skills.find((skill) => skill.id === "lock-a")!;
  await f.store.pin(canonical.id, true); skills = await f.store.list();
  const aliases = planReuseGovernance(skills, [], { now }).suggestions.filter((item) => item.kind === "duplicate-alias");
  assert.equal(aliases.length, 1); assert.equal(aliases[0]!.skillId, "lock-b"); assert.equal(aliases[0]!.canonicalId, "lock-a");
  const before = await fs.readFile(first.path, "utf8");
  const result = await applyReuseGovernance(f.root, planReuseGovernance(skills, [], { now }), {});
  assert.equal(result.skipped.some((item) => item.action === "duplicate-alias"), true);
  assert.equal(await fs.readFile(first.path, "utf8"), before); assert.equal((await f.store.inspect("lock-b")).skill.archived, false);
  assert.equal(second.id, "lock-b");
});

test("apply rechecks managed ownership, pin and current content hash and archives only explicit archive suggestions", async (t) => {
  const f = await fixture(t), saved = await f.save("archive-me"), skill = (await f.store.list())[0]!;
  const plan = planReuseGovernance([skill], [stat(skill, { success: 0, failure: 3 })], { now });
  const dry = await applyReuseGovernance(f.root, plan, { dryRun: true }); assert.equal(dry.applied.length, 1);
  const applied = await applyReuseGovernance(f.root, plan); assert.deepEqual(applied.applied, [{ skillId: "archive-me", action: "archive" }]);
  assert.equal((await f.store.inspect("archive-me")).skill.archived, true);
  const rerun = await applyReuseGovernance(f.root, plan); assert.equal(rerun.applied.length, 0); assert.equal(rerun.skipped[0]!.reason, "ownership, pin or content hash changed");
  assert.equal(saved.changed, true);
});

test("governance plans reject malformed policy and do not infer staleness without a date", () => {
  const skill: ExistingSkill = { id: "unknown-date", name: "Unknown", description: "Unknown", path: "unknown", managed: true, ownership: "managed", pinned: false, archived: false, sha256: "e".repeat(64) };
  assert.equal(planReuseGovernance([skill], [stat(skill, { success: 0, failure: 1 })], { now }).suggestions.length, 0);
  assert.throws(() => planReuseGovernance([skill], [], { staleAfterDays: 0 }), /policy/i);
  assert.throws(() => planReuseGovernance([skill], [], { archiveSuccessRate: 2 }), /policy/i);
});
