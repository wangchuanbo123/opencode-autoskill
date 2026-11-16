import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AutoSkillEngine } from "../dist/engine.js";
import { buildReviewInput, parseDecision } from "../dist/review.js";
import { readOptions } from "../dist/config.js";
import { QueueStore } from "../dist/jobs.js";
import { DraftStore } from "../dist/drafts.js";
import type { EnginePort, ReviewDecision, TaskSnapshot } from "../src/types.ts";
import { assessmentFor, withAssessment } from "./helpers/assessment.ts";

const procedure = "Root cause: concurrent migration holds a transient database lock because its transaction is unfinished. Compared fixed delay versus bounded exponential backoff; choose bounded backoff to preserve the deadline and avoid retrying permanent schema errors.";
const verified = "Regression suite: 12 tests passed; lock retry verified.";
function candidate(): ReviewDecision {
  return withAssessment({ action: "create", reason: "A verified reusable lock recovery method.", taskCompleted: true, reusable: true, confidence: 0.95,
    skill: { id: "database-lock-retry", name: "Database lock retry", description: "Use when a migration meets a transient database lock.",
      whenToUse: ["Transient migration lock failure."], prerequisites: ["A reproducible lock fixture."],
      steps: ["Identify transient locks from the observed error.", "Use bounded retries and run the regression fixture."],
      pitfalls: ["Do not retry permanent schema errors."], verification: ["Run the lock regression suite and inspect its result."] },
    evidence: [{ toolCallId: "call-0", excerpt: procedure, supports: "procedure" }, { toolCallId: "call-7", excerpt: verified, supports: "verification" }] });
}

async function fixture(t: test.TestContext, options: Record<string, unknown> = {}, setup?: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-engine-"));
  const snapshot: TaskSnapshot = { sessionId: "session-1", directory: root, terminal: "success", model: { providerID: "local", id: "test" },
    messages: [{ id: "user-1", role: "user", text: "Investigate and verify how to recover from migration lock failures.", tools: [] },
      { id: "assistant-1", role: "assistant", text: "The procedure is verified.", tools: Array.from({ length: 8 }, (_, index) => ({
        id: `call-${index}`, name: "shell", status: "completed" as const,
        input: { command: index === 7 ? "npm test" : index === 0 ? "inspect migration lock root cause" : "read diagnostic fixture" },
        output: index === 0 ? procedure : index === 7 ? verified : `Diagnostic check ${index}: result confirmed.`,
      })) }] };
  const calls: { prompt: string; model?: unknown; signal: AbortSignal }[] = [];
  const logs: string[] = [];
  let output = JSON.stringify(candidate());
  let reloads = 0;
  const port: EnginePort = { root, options: { cooldownMs: 0, retryBaseMs: 60_000, globalStateDirectory: path.join(root, "private-global"), ...options }, snapshot: async () => structuredClone(snapshot),
    generate: async (input) => { calls.push(input); return output; }, listSkills: async () => [],
    reloadSkills: async () => { reloads++; }, log: (_level, message) => { logs.push(message); } };
  await setup?.(root);
  const engine = new AutoSkillEngine(port);
  const engines = [engine];
  t.after(async () => { await Promise.all(engines.map(item => item.dispose())); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-engine-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, snapshot, port, engine, calls, logs, makeEngine() { const other = new AutoSkillEngine(port); engines.push(other); return other; }, setOutput(value: unknown) { output = JSON.stringify(value); }, get reloads() { return reloads; } };
}

test("verified complex read-only work produces a discoverable skill and durable task identity", async (t) => {
  const f = await fixture(t);
  const result = await f.engine.review("session-1");
  assert.equal(result.status, "saved");
  assert.equal(f.reloads, 1);
  assert.match(await fs.readFile(result.path!, "utf8"), /database-lock-retry/);
  const source = JSON.parse(await fs.readFile(path.join(f.root, ".opencode/autoskill/provenance/database-lock-retry/SOURCE.json"), "utf8"));
  assert.equal(source.evidence[1].excerpt, verified);
  assert.equal(source.fingerprint.length, 64);
  assert.deepEqual(f.calls[0].model, { providerID: "local", id: "test" });
  const again = f.makeEngine();
  assert.equal((await again.review("session-1")).reasonCode, "already_reviewed");
  assert.equal(f.calls.length, 1);
  const state = JSON.parse(await fs.readFile(path.join(f.root, ".opencode/autoskill/state.json"), "utf8"));
  assert.equal(state.reviews, 1);
  assert.equal(state.sessions["session-1"].cursor, undefined);
  assert.ok(state.sessions["session-1"].lastReview > 0);
  const status = await again.status() as any;
  assert.equal(status.jobs.filter(job => job.status === "saved").length, 1);
});

test("a nontrivial few-call investigation is eligible; force cannot bypass evidence", async (t) => {
  const f = await fixture(t);
  f.snapshot.messages[1].tools = [f.snapshot.messages[1].tools[0], f.snapshot.messages[1].tools[7]];
  assert.equal((await f.engine.review("session-1")).status, "saved");
  const g = await fixture(t);
  g.snapshot.messages[1].tools = g.snapshot.messages[1].tools.slice(0, 1);
  assert.match((await g.engine.review("session-1", true)).reason, /Insufficient/);
  assert.equal(g.calls.length, 0);
});

test("failure, pending, child sessions, and a different project do not invoke review model", async (t) => {
  const f = await fixture(t);
  for (const terminal of ["failure", "interrupted"] as const) {
    f.snapshot.terminal = terminal;
    assert.equal((await f.engine.review("session-1", true)).status, "skipped");
  }
  f.snapshot.terminal = "success";
  f.snapshot.parentId = "parent";
  assert.equal((await f.engine.review("session-1", true)).status, "skipped");
  delete f.snapshot.parentId;
  f.snapshot.messages[1].tools[0].status = "pending";
  assert.match((await f.engine.review("session-1", true)).reason, /unfinished/);
  f.snapshot.messages[1].tools[0].status = "completed";
  f.snapshot.directory = os.tmpdir();
  assert.equal((await f.engine.review("session-1", true)).status, "skipped");
  assert.equal(f.calls.length, 0);
});

test("fabricated verification fails once without blindly retrying invalid candidates", async (t) => {
  const f = await fixture(t);
  const decision = candidate();
  decision.evidence![1].excerpt = "Invented tests passed with no matching output";
  f.setOutput(decision);
  assert.equal((await f.engine.review("session-1")).status, "failed");
  assert.equal((await f.engine.review("session-1")).reasonCode, "already_reviewed");
  assert.equal((await f.engine.review("session-1", true)).reasonCode, "already_reviewed");
  assert.equal(f.calls.length, 1);
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
});

test("an incomplete model skip does not donate old evidence to an unrelated new task", async (t) => {
  const f = await fixture(t);
  f.setOutput({ action: "skip", reason: "Goal is still incomplete.", taskCompleted: false, reusable: false, confidence: 0.9 });
  assert.equal((await f.engine.review("session-1")).status, "skipped");
  f.snapshot.messages.push({ id: "user-2", role: "user", text: "Inspect a separate cache configuration", tools: [] },
    { id: "assistant-2", role: "assistant", text: "Verification finished", tools: [{ id: "call-extra", name: "read", output: "Additional result confirmed", status: "completed" }] });
  f.setOutput(candidate());
  assert.equal((await f.engine.review("session-1", true)).reasonCode, "insufficient_evidence");
  assert.equal(f.calls.length, 1);
});

test("appended tasks update owned skills without reusing old evidence windows", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.engine.review("session-1")).status, "saved");
  const next = structuredClone(f.snapshot.messages);
  next[0].id = "user-2";
  next[1].id = "assistant-2";
  next[1].tools.forEach((tool) => { tool.id = tool.id.replace("call", "next"); });
  f.snapshot.messages.push(...next);
  const update = candidate(); update.action = "update"; update.skill!.steps.push("Limit retries to the configured budget.");
  update.evidence!.forEach((item) => { item.toolCallId = item.toolCallId.replace("call", "next"); });
  update.assessment = assessmentFor(update.evidence!);
  f.setOutput(update);
  assert.equal((await f.engine.review("session-1")).status, "saved");
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(f.calls[1].prompt.split("<existing-skills>")[0], /"id":"user-1"/);
  const backups = await fs.readdir(path.join(f.root, ".opencode/autoskill/backups/database-lock-retry"));
  assert.ok(backups.some((file) => file.endsWith("SKILL.md")));
});

test("daily budget also limits force reviews and failed model calls", async (t) => {
  const f = await fixture(t, { maxReviewsPerDay: 1 });
  f.port.generate = async (input) => { f.calls.push(input); throw new Error("provider unavailable"); };
  assert.equal((await f.engine.review("session-1")).status, "queued");
  f.snapshot.sessionId = "session-2";
  assert.equal((await f.engine.review("session-2", true)).reasonCode, "project_daily_budget");
  assert.equal(f.calls.length, 1);
});

test("timeout aborts the provider and returns even if it ignores cancellation", async (t) => {
  const f = await fixture(t, { reviewTimeoutMs: 1_500 });
  await f.engine.status();
  let signal: AbortSignal;
  let providerCompleted = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.generate = async (input) => { signal = input.signal; await gate; providerCompleted = true; return JSON.stringify(candidate()); };
  assert.equal((await f.engine.review("session-1")).reasonCode, "review_timeout");
  assert.equal(providerCompleted, false);
  assert.equal(signal!.aborted, true);
  release();
});

test("one project lock prevents duplicate model calls across engine instances", async (t) => {
  const f = await fixture(t);
  let started!: () => void; const hasStarted = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
  f.port.generate = async () => { started(); await gate; return JSON.stringify(candidate()); };
  const first = f.engine.review("session-1");
  await hasStarted;
  const other = f.makeEngine();
  assert.equal((await f.engine.review("session-1")).status, "busy");
  assert.equal((await other.review("session-1")).status, "busy");
  finish();
  assert.equal((await first).status, "saved");
});

test("changed evidence during review cannot commit a stale candidate", async (t) => {
  const f = await fixture(t);
  f.port.generate = async () => { f.snapshot.messages[0].text = "Actually cancel that task"; return JSON.stringify(candidate()); };
  assert.match((await f.engine.review("session-1")).reason, /changed/);
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
});

test("background terminal events debounce and failure cancels scheduled work", async (t) => {
  const f = await fixture(t, { debounceMs: 20 });
  f.engine.schedule("session-1", "success");
  f.engine.schedule("session-1", "idle");
  for (let tries = 0; tries < 50 && f.reloads === 0; tries++) await delay(20);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads, 1);
  const g = await fixture(t, { debounceMs: 20 });
  g.engine.schedule("session-1", "success");
  g.snapshot.terminal = "failure";
  g.engine.schedule("session-1", "failure");
  await delay(50);
  assert.equal(g.calls.length, 0);
});

test("review prompt excludes secrets; journal does not persist transcript", async (t) => {
  const f = await fixture(t);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  f.snapshot.messages[0].text += ` api_key=${secret}`;
  f.snapshot.messages[1].error = `Earlier provider error: api_key=${secret}`;
  assert.equal((await f.engine.review("session-1")).status, "saved");
  assert.doesNotMatch(f.calls[0].prompt, new RegExp(secret));
  const journal = await fs.readFile(path.join(f.root, ".opencode/autoskill/events.jsonl"), "utf8");
  assert.doesNotMatch(journal, /Investigate|Regression suite|sk-/);
});

test("redaction precedes truncation, including existing skill bodies", async (t) => {
  const f = await fixture(t);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const secretAtCut = "A".repeat(68) + " " + secret + " " + "Z".repeat(80);
  f.snapshot.messages[1].tools[0].output = secretAtCut;
  const input = await buildReviewInput(f.snapshot, [{ id: "owned", name: "owned", description: "Existing technique", path: "unused", managed: true,
    content: "A".repeat(2_780) + " " + secret + " " + "Z".repeat(2_000) }], readOptions({ maxToolOutputChars: 100 }), f.root);
  assert.doesNotMatch(input.prompt, /sk-abc/);
});

test("possible secret in generated content is rejected before persistence", async (t) => {
  const f = await fixture(t);
  const decision = candidate();
  decision.skill!.steps.push("Use api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789");
  f.setOutput(decision);
  assert.equal((await f.engine.review("session-1")).status, "failed");
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
});

test("updating requires the complete prior skill body within the reviewer budget", async (t) => {
  const f = await fixture(t);
  const fullBody = "Original instructions.\n" + "Important preserved rule.\n".repeat(240);
  const existing = { id: "database-lock-retry", name: "Database lock retry", description: "Existing procedure", path: "unused", content: fullBody, contentComplete: true, managed: true };
  const complete = await buildReviewInput(f.snapshot, [existing], readOptions(), f.root);
  assert.ok(complete.updateableIds.has(existing.id));
  assert.ok(complete.prompt.includes(JSON.stringify(fullBody)));
  const partial = await buildReviewInput(f.snapshot, [{ ...existing, contentComplete: false }], readOptions(), f.root);
  assert.equal(partial.updateableIds.has(existing.id), false);
  assert.doesNotMatch(partial.prompt, /Important preserved rule/);
  const tooLarge = await buildReviewInput(f.snapshot, [{ ...existing, content: "x".repeat(24_001) }], readOptions(), f.root);
  assert.equal(tooLarge.updateableIds.has(existing.id), false);
});

test("unknown model fields cannot be persisted in skill provenance", async (t) => {
  const f = await fixture(t);
  const decision = candidate() as any;
  decision.unrequested = "private model commentary";
  decision.evidence[0].unrequested = "private source context";
  f.setOutput(decision);
  const saved = await f.engine.review("session-1");
  assert.equal(saved.status, "saved");
  const source = await fs.readFile(path.join(f.root, ".opencode/autoskill/provenance/database-lock-retry/SOURCE.json"), "utf8");
  assert.doesNotMatch(source, /unrequested|private source|private model/);
});

test("decision gate rejects failed/same-tool evidence, user-owned updates, duplicate names, and low quality", async (t) => {
  const f = await fixture(t);
  const options = readOptions();
  const input = await buildReviewInput(f.snapshot, [], options, f.root);
  const checks = [
    (d) => { d.evidence[1].toolCallId = "missing"; },
    (d) => { d.evidence[1].toolCallId = "call-0"; d.evidence[1].excerpt = procedure; },
    (d) => { d.confidence = 0.5; },
    (d) => { d.skill.steps = ["Only one step"]; },
    (d) => { d.taskCompleted = false; },
    (d) => { d.action = "update"; },
  ];
  for (const mutate of checks) { const d = candidate(); mutate(d); assert.throws(() => parseDecision(JSON.stringify(d), input.evidence, [], options, f.root)); }
  const failed = new Map(input.evidence); failed.set("call-7", { ...failed.get("call-7")!, status: "error" });
  assert.throws(() => parseDecision(JSON.stringify(candidate()), failed, [], options, f.root), /Failed tools/);
  const existing = { id: "other-skill", name: candidate().skill!.name, description: "different", path: "other", managed: false };
  assert.throws(() => parseDecision(JSON.stringify(candidate()), input.evidence, [existing], options, f.root), /equivalent/);
  const update = candidate(); update.action = "update";
  assert.throws(() => parseDecision(JSON.stringify(update), input.evidence, [{ ...existing, id: update.skill!.id }], options, f.root), /plugin-owned/);
  const placeholders = new Map(input.evidence); placeholders.set("call-7", { ...placeholders.get("call-7")!, output: "[REDACTED]\nExit code: 0" });
  const placeholderCitation = candidate(); placeholderCitation.evidence![1].excerpt = "[REDACTED]";
  assert.throws(() => parseDecision(JSON.stringify(placeholderCitation), placeholders, [], options, f.root), /substantive/);
});

test("state junctions are rejected without writing outside the project", async (t) => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-outside-"));
  t.after(async () => { assert.equal(path.dirname(outside), path.resolve(os.tmpdir())); assert.ok(path.basename(outside).startsWith("autoskill-outside-")); await fs.rm(outside, { recursive: true, force: true }); });
  const f = await fixture(t, {}, async root => {
    await fs.mkdir(path.join(root, ".opencode"));
    await fs.symlink(outside, path.join(root, ".opencode/autoskill"), process.platform === "win32" ? "junction" : "dir");
  });
  assert.equal((await f.engine.review("session-1")).status, "failed");
  assert.deepEqual(await fs.readdir(outside), []);
});

test("timeout while rechecking the completed boundary prevents a late commit", async t => {
  const f = await fixture(t, { reviewTimeoutMs: 600 });
  let snapshots = 0;
  let entered!: () => void;
  const rechecking = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let recheckSignal: AbortSignal | undefined;
  f.port.snapshot = async (_sessionId, _terminal, signal) => {
    if (++snapshots === 2) { recheckSignal = signal; entered(); await gate; }
    return structuredClone(f.snapshot);
  };
  const reviewing = f.engine.review("session-1");
  await rechecking;
  const result = await reviewing;
  assert.equal(result.reasonCode, "review_timeout");
  assert.equal(recheckSignal?.aborted, true);
  release();
  await delay(40);
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
});

test("external cancellation aborts model work and cannot publish a late response", async t => {
  const f = await fixture(t);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let modelSignal: AbortSignal | undefined;
  f.port.generate = async input => { f.calls.push(input); modelSignal = input.signal; started(); await gate; return JSON.stringify(candidate()); };
  const controller = new AbortController();
  const reviewing = f.engine.review("session-1", false, controller.signal);
  await running;
  controller.abort();
  const result = await reviewing;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reasonCode, "user_cancelled");
  assert.equal(modelSignal?.aborted, true);
  release();
  await delay(40);
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
  assert.equal((await f.engine.status() as any).jobs.find(job => job.id === result.taskId).status, "cancelled");
});

test("draft mode and manual dry-run persist reviewable candidates without publishing skills", async t => {
  for (const mode of ["draft", "auto"] as const) {
    const f = await fixture(t, { mode });
    const result = await f.engine.review("session-1", false, undefined, mode === "auto");
    assert.equal(result.status, "draft");
    assert.equal(f.calls.length, 1);
    assert.equal(f.reloads, 0);
    await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/database-lock-retry/SKILL.md")));
    const drafts = new DraftStore(f.root);
    assert.equal((await drafts.inspect(result.taskId!)).decision.skill!.id, "database-lock-retry");
    assert.equal((await drafts.list())[0]!.status, "draft");
    await f.engine.dispose();
    await drafts.publish(result.taskId!);
    assert.equal((await drafts.list())[0]!.status, "published");
  }
});

test("a queued transient failure resumes automatically after engine restart", async t => {
  const f = await fixture(t);
  f.port.generate = async input => { f.calls.push(input); throw new Error("Temporary provider network unavailable (503)"); };
  const first = await f.engine.review("session-1");
  assert.equal(first.status, "queued");
  assert.equal(f.calls.length, 1);
  await f.engine.dispose();
  const queue = new QueueStore(f.root);
  try { await queue.transaction(state => { state.jobs[first.taskId!]!.nextRunAt = Date.now(); }); }
  finally { await queue.close(); }
  f.port.generate = async input => { f.calls.push(input); return JSON.stringify(candidate()); };
  const restarted = f.makeEngine();
  let status: any;
  for (let attempt = 0; attempt < 80; attempt++) {
    status = await restarted.status();
    if (status.jobs?.some(job => job.id === first.taskId && job.status === "saved")) break;
    await delay(25);
  }
  const completed = status.jobs.find(job => job.id === first.taskId);
  assert.equal(completed.status, "saved");
  assert.equal(completed.attempts, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.reloads, 1);
});

test("task boundaries and packet tails preserve every tool without mixing separate objectives", async t => {
  const f = await fixture(t, { debounceMs: 0 });
  f.snapshot.messages[1]!.tools = Array.from({ length: 100 }, (_, index) => ({ id: `batch-${index}`, name: "shell", status: "completed" as const,
    input: { command: index === 99 ? "npm test -- migration-lock" : "inspect diagnostic checkpoint" },
    output: index === 99 ? verified : index === 98 ? procedure : `Observed procedure checkpoint ${index}: database lock inspection completed.` }));
  const second = structuredClone(f.snapshot.messages);
  second[0]!.id = "user-2";
  second[0]!.text = "Implement and verify an independent cache cleanup procedure.";
  second[1]!.id = "assistant-2";
  second[1]!.tools = second[1]!.tools.slice(0, 8).map((tool, index) => ({ ...tool, id: `cache-${index}`, input: { command: index === 7 ? "npm test -- cache" : index === 0 ? "inspect cache root cause" : "inspect cache manifest" }, output: index === 7 ? "Cache regression suite passed independently: selective cache invalidation preserves valid records." : index === 0 ? "Root cause: cache entries are stale because the manifest schema mismatches its stored records. Compared deleting every record versus selective invalidation; choose selective invalidation to preserve valid cache records." : `Observed cache cleanup checkpoint ${index}.` }));
  f.snapshot.messages.push(...second);
  const reviewedTools = new Set<string>();
  const objectives: string[] = [];
  f.port.generate = async input => {
    f.calls.push(input);
    const start = input.prompt.lastIndexOf("<task-evidence>\n") + "<task-evidence>\n".length;
    const body = JSON.parse(input.prompt.slice(start, input.prompt.indexOf("\n</task-evidence>", start)));
    objectives.push(body.messages[0].text);
    const tools = body.messages.flatMap(message => message.tools);
    tools.forEach(tool => reviewedTools.add(tool.id));
    const record = candidate();
    record.skill!.id = `workflow-${f.calls.length}`;
    record.skill!.name = `Verified workflow ${f.calls.length}`;
    record.skill!.description = `Use the verified task procedure for independent workflow ${f.calls.length}.`;
    const method = tools.find(tool => tool.output.includes("Root cause:"))!;
    record.evidence = [{ toolCallId: method.id, excerpt: method.output, supports: "procedure" }, { toolCallId: tools.at(-1).id, excerpt: tools.at(-1).output, supports: "verification" }];
    record.assessment = assessmentFor(record.evidence);
    return JSON.stringify(record);
  };
  assert.equal((await f.engine.review("session-1")).status, "saved");
  let status: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await f.engine.status();
    if (status.jobs?.filter(job => job.status === "saved").length === 4) break;
    await delay(25);
  }
  assert.equal(status.jobs.filter(job => job.status === "saved").length, 4);
  assert.equal(f.calls.length, 4);
  assert.equal(reviewedTools.size, 108);
  assert.equal(objectives.filter(goal => goal.includes("migration lock")).length, 3);
  assert.equal(objectives.filter(goal => goal.includes("cache cleanup")).length, 1);
  assert.ok(objectives.every(goal => !goal.includes("migration lock") || !goal.includes("cache cleanup")));
});

test("the shared daily budget applies across projects and force cannot bypass it", async t => {
  const first = await fixture(t, { maxGlobalReviewsPerDay: 1 });
  const shared = first.port.options!.globalStateDirectory;
  const second = await fixture(t, { maxGlobalReviewsPerDay: 1, globalStateDirectory: shared });
  try {
    assert.equal((await first.engine.review("session-1")).status, "saved");
    const blocked = await second.engine.review("session-1", true);
    assert.equal(blocked.status, "queued");
    assert.match(blocked.reasonCode!, /global.*review.*budget/);
    assert.equal(second.calls.length, 0);
    assert.ok(blocked.nextRunAt! > Date.now());
  } finally { await Promise.all([first.engine.dispose(), second.engine.dispose()]); }
});

test("a persisted draft recovers an interrupted queue commit without another model call", async t => {
  const f = await fixture(t, { mode: "draft" });
  const created = await f.engine.review("session-1");
  assert.equal(created.status, "draft");
  await f.engine.dispose();
  const queue = new QueueStore(f.root);
  try {
    await queue.transaction(state => { const job = state.jobs[created.taskId!]; job.status = "retry"; job.nextRunAt = Date.now(); });
    const recovered = await f.makeEngine().review("session-1");
    assert.equal(recovered.status, "draft"); assert.equal(recovered.reasonCode, "draft_recovered");
    assert.equal(f.calls.length, 1);
    assert.equal((await queue.read()).jobs[created.taskId!].status, "draft");
  } finally { await queue.close(); }
});
