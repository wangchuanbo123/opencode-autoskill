import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AutoSkillEngine } from "../dist/engine.js";
import { QueueStore } from "../dist/jobs.js";
import { collectTasks } from "../dist/tasks.js";
import { readOptions } from "../dist/config.js";
import type { EnginePort, ReviewDecision, TaskSnapshot } from "../src/types.ts";
import { withAssessment } from "./helpers/assessment.ts";
import { runCli } from "../bin/autoskill.mjs";
import { DraftStore } from "../dist/drafts.js";

const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/complexity.json", import.meta.url), "utf8"));
async function fixture(t: test.TestContext, caseId: string, overrides: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-eligibility-"));
  const snapshot: TaskSnapshot = structuredClone(corpus.cases.find((item: any) => item.id === caseId).snapshot);
  snapshot.directory = root;
  const tools = snapshot.messages.flatMap((message) => message.tools);
  const output: ReviewDecision = withAssessment({ action: "create", reason: "A grounded tenant isolation diagnosis can be reused.", taskCompleted: true, reusable: true, confidence: 0.96,
    skill: { id: "tenant-cache-diagnosis", name: "Tenant cache isolation diagnosis", description: "Use when invoice records leak between tenant-specific cache entries.",
      whenToUse: ["Identical invoice IDs collide across tenants."], prerequisites: [],
      steps: ["Reproduce a collision with two tenants sharing an invoice ID.", "Identify the omitted tenant dimension and verify isolated keys with a regression."],
      pitfalls: ["An invoice ID alone is not a globally unique cache key."], verification: ["Run independent tenant isolation regressions."] },
    evidence: [{ toolCallId: tools[0]!.id, excerpt: tools[0]!.output, supports: "procedure" },
      { toolCallId: tools.at(-1)!.id, excerpt: tools.at(-1)!.output, supports: "verification" }] });
  const options = { cooldownMs: 0, debounceMs: 0, globalStateDirectory: path.join(root, "private-global"), ...overrides };
  let calls = 0;
  const port: EnginePort = { root, options, snapshot: async () => structuredClone(snapshot), generate: async () => { calls++; return JSON.stringify(output); },
    listSkills: async () => [], reloadSkills: async () => {}, log: () => {} };
  const engine = new AutoSkillEngine(port);
  await engine.status();
  const queue = new QueueStore(root);
  t.after(async () => { await engine.dispose(); await queue.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-eligibility-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const packet = () => collectTasks(snapshot, readOptions(options), root)[0]!;
  async function seed(status: "pending" | "skipped" | "saved", extra: Record<string, unknown> = {}) {
    const p = packet();
    await queue.upsert({ id: p.id, taskId: p.taskId, sessionId: snapshot.sessionId, fingerprint: p.fingerprint, snapshot: p.snapshot,
      status, attempts: 0, createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: 0, ...extra });
    return p.id;
  }
  async function waitTerminal(id: string) {
    for (let index = 0; index < 150; index++) {
      const job = (await queue.read()).jobs[id];
      if (job && ["saved", "skipped", "failed", "draft"].includes(job.status)) return job;
      await delay(20);
    }
    assert.fail("automatic review did not finish");
  }
  return { root, snapshot, output, engine, queue, packet, seed, waitTerminal, get calls() { return calls; } };
}

test("automatic screening rejects repeated reads even with legacy call thresholds set to one", async (t) => {
  const f = await fixture(t, "repeated-identical-read", { minToolCalls: 1, minToolCallsWithErrors: 1 });
  const repeated = f.snapshot.messages[1]!.tools;
  for (let index = 8; index < 20; index++) repeated.push({ ...repeated[0]!, id: `repeat-${index}` });
  f.engine.schedule(f.snapshot.sessionId, "success");
  const job = await f.waitTerminal(f.packet().id);
  assert.equal(job.reasonCode, "below_complexity_threshold");
  assert.equal((job.preScreen as any).eligible, false);
  assert.equal((job.preScreen as any).uniqueOperations, 1);
  assert.equal(f.calls, 0);
  assert.equal((await f.queue.read()).reviews, 0);
});

test("two-call nontrivial investigation triggers automatically and saves separate assessments", async (t) => {
  const f = await fixture(t, "two-call-root-cause");
  f.engine.schedule(f.snapshot.sessionId, "success");
  assert.equal((await f.waitTerminal(f.packet().id)).status, "saved");
  assert.equal(f.calls, 1);
  const source = JSON.parse(await fs.readFile(path.join(f.root, ".opencode/autoskill/provenance/tenant-cache-diagnosis/SOURCE.json"), "utf8"));
  assert.equal(source.pluginVersion, "0.4.0");
  assert.equal(source.assessment.complexity.nontrivial, true);
  assert.equal(source.assessment.value.addsKnowledge, true);
  assert.equal(source.assessment.value.evidence.length, 2);
  const status = await f.engine.status() as any;
  assert.equal(status.screeningPolicy.callCountIsTrigger, false);
  assert.equal(status.jobs.find((job: any) => job.status === "saved").preScreen.eligible, true);
  const cliOutput: string[] = [];
  assert.equal(await runCli(["status", "--runtime", "--project", f.root], { out(value: string) { cliOutput.push(value); }, error() {} }), 0);
  const cli = JSON.parse(cliOutput.at(-1)!);
  assert.equal(cli.runtime.jobs.find((job: any) => job.status === "saved").preScreen.version, "evidence-v1");
  assert.doesNotMatch(JSON.stringify(cli.runtime), /Root cause identified|invoice:42/);
});

test("legacy below-threshold skips are rescreened under the new policy; published tasks stay deduplicated", async (t) => {
  const f = await fixture(t, "two-call-root-cause");
  await f.seed("skipped", { reasonCode: "below_complexity_threshold", screeningKey: "legacy-count-v0.2" });
  assert.equal((await f.engine.review(f.snapshot.sessionId)).status, "saved");
  await f.queue.transaction((state) => { state.jobs[f.packet().id]!.screeningKey = "old-policy"; });
  assert.equal((await f.engine.review(f.snapshot.sessionId)).reasonCode, "already_reviewed");
  assert.equal(f.calls, 1);
});

test("legacy pending count-only jobs are blocked before model calls and budget reservations", async (t) => {
  const f = await fixture(t, "repeated-identical-read");
  const id = await f.seed("pending");
  const job = await f.waitTerminal(id);
  assert.equal(job.status, "skipped");
  assert.equal(job.reasonCode, "below_complexity_threshold");
  assert.equal((job.preScreen as any).version, "evidence-v1");
  assert.equal(f.calls, 0);
  assert.equal((await f.queue.read()).reviews, 0);
});

test("manual force applies to an already queued job but cannot bypass the semantic assessment", async (t) => {
  const f = await fixture(t, "repeated-identical-read");
  delete f.output.assessment;
  await f.seed("pending");
  assert.equal((await f.engine.review(f.snapshot.sessionId, true)).reasonCode, "candidate_invalid");
  assert.equal(f.calls, 1);
  assert.equal((await f.queue.read()).jobs[f.packet().id]!.force, true);
  await assert.rejects(fs.access(path.join(f.root, ".opencode/skills/tenant-cache-diagnosis/SKILL.md")));
});

test("automatic recapture preserves a queued explicit force request and still enforces reuse value", async (t) => {
  const f = await fixture(t, "repeated-identical-read");
  f.output.assessment!.value.nonObvious = false;
  const id = await f.seed("pending", { force: true });
  f.engine.schedule(f.snapshot.sessionId, "success");
  assert.equal((await f.waitTerminal(id)).reasonCode, "candidate_invalid");
  assert.equal(f.calls, 1);
});

test("storeEvidence none clears new assessment citations from published provenance", async (t) => {
  const f = await fixture(t, "two-call-root-cause", { storeEvidence: "none" });
  const result = await f.engine.review(f.snapshot.sessionId);
  assert.equal(result.status, "saved");
  const source = JSON.parse(await fs.readFile(path.join(f.root, ".opencode/autoskill/provenance/tenant-cache-diagnosis/SOURCE.json"), "utf8"));
  assert.deepEqual(source.evidence, []);
  assert.deepEqual(source.assessment.value.evidence, []);
  assert.ok(source.assessment.complexity.dimensions.every((dimension: any) => dimension.evidence.length === 0));
});

test("all packets inherit task assessment in original chronology despite shared final checks", async (t) => {
  const f = await fixture(t, "diagnose-change-verify");
  const tools = f.snapshot.messages[1]!.tools;
  f.snapshot.messages[1]!.tools = [
    ...Array.from({ length: 49 }, (_, index) => ({ id: `inventory-${index}`, name: "read", status: "completed" as const,
      input: { file: "inventory.txt" }, output: "Routine inventory contents unchanged." })), ...tools,
  ];
  f.output.action = "skip";
  f.output.reason = "This reviewer fixture deliberately declines publication after routing.";
  const packets = collectTasks(f.snapshot, readOptions(), f.root);
  assert.equal(packets.length, 2);
  f.engine.schedule(f.snapshot.sessionId, "success");
  for (const packet of packets) {
    const job = await f.waitTerminal(packet.id);
    assert.equal(job.reasonCode, "model_skipped");
    const screen = job.preScreen as any;
    assert.equal(screen.eligible, true);
    assert.equal(screen.dimensions.diagnosticResolution.present, true);
  }
  assert.equal(f.calls, packets.length);
});

test("legacy drafts remain inspectable and cannot publish without the current semantic assessment", async (t) => {
  const f = await fixture(t, "two-call-root-cause");
  const packet = f.packet();
  const drafts = new DraftStore(f.root);
  await drafts.create({ id: packet.id, decision: f.output,
    provenance: { sessionId: f.snapshot.sessionId, taskId: packet.id, fingerprint: packet.fingerprint,
      messageIds: f.snapshot.messages.map((message) => message.id), createdAt: new Date().toISOString(), evidence: f.output.evidence! },
    evidence: f.snapshot.messages.flatMap((message) => message.tools) });
  const file = path.join(f.root, ".opencode/autoskill/drafts", `${packet.id}.json`);
  const legacy = JSON.parse(await fs.readFile(file, "utf8"));
  delete legacy.decision.assessment;
  await fs.writeFile(file, JSON.stringify(legacy));
  await f.seed("pending");
  await f.engine.review(f.snapshot.sessionId);
  assert.equal((await f.queue.read()).jobs[packet.id]!.reasonCode, "legacy_draft_requires_review");
  assert.equal(f.calls, 0);
  assert.equal((await drafts.inspect(packet.id)).decision.skill!.id, f.output.skill!.id);
  await assert.rejects(drafts.publish(packet.id), /assessment/i);
  assert.equal((await drafts.discard(packet.id)).status, "discarded");
});
