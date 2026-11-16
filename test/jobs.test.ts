import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { QueueStore, GlobalBudgetStore, type QueueJob } from "../dist/jobs.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-jobs-"));
  const stores: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await Promise.all(stores.map((store) => store.close()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-jobs-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store() { const store = new QueueStore(root); stores.push(store); return store; }, budget() { const store = new GlobalBudgetStore(path.join(root, "private-budget")); stores.push(store); return store; } };
}

function job(id = "job-1", overrides = {}): QueueJob {
  return { id, sessionId: "session", fingerprint: `fingerprint-${id}`, status: "pending", attempts: 0,
    createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: 0,
    snapshot: { sessionId: "session", directory: "<PROJECT>", terminal: "success", messages: [{ id: "user", role: "user", text: "Redacted task evidence", tools: [] }] },
    ...overrides };
}

test("queue survives reopen, deduplicates evidence and exports no transcript payload", async (t) => {
  const f = await fixture(t);
  const store = f.store();
  assert.equal((await store.upsert(job())).inserted, true);
  assert.equal((await store.upsert(job())).inserted, false);
  await store.close();
  const reopened = f.store();
  const state = await reopened.read();
  assert.equal(state.version, 2);
  assert.equal(state.jobs["job-1"].snapshot!.messages[0].text, "Redacted task evidence");
  const diagnostics = await fs.readFile(path.join(f.root, ".opencode/autoskill/state.json"), "utf8");
  assert.doesNotMatch(diagnostics, /Redacted task evidence|"snapshot"/);
  assert.match(await fs.readFile(path.join(f.root, ".opencode/autoskill/.gitignore"), "utf8"), /^\*$/m);
});

test("transactions roll back failures and forbid asynchronous callbacks", async (t) => {
  const f = await fixture(t); const store = f.store();
  await store.upsert(job());
  await assert.rejects(store.transaction((state) => { state.reviews = 9; delete state.jobs["job-1"]; throw Error("abort transaction"); }), /abort transaction/);
  assert.equal((await store.read()).reviews, 0);
  assert.ok((await store.read()).jobs["job-1"]);
  await assert.rejects(store.transaction(async (state) => { state.reviews = 12; }), /must be synchronous/);
  assert.equal((await store.read()).reviews, 0);
});

test("concurrent instances claim one lease and a stale token cannot commit", async (t) => {
  const f = await fixture(t); const first = f.store(); const second = f.store();
  await first.upsert(job());
  const claims = await Promise.all([first.claim(), second.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const owned = claims.find(Boolean)!;
  assert.equal(await second.finish(owned.id, "different-token", { status: "saved", reason: "not owner" }, "saved"), false);
  assert.equal(await first.finish(owned.id, owned.lease!.token, { status: "saved", reason: "committed" }, "saved"), true);
  assert.equal((await second.read()).jobs[owned.id].status, "saved");
});

test("recovery requeues dead/expired leases, keeps live work and returns unfinished publications", async (t) => {
  const f = await fixture(t); const store = f.store();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await once(child, "exit");
  await store.upsert(job("dead", { status: "running", lease: { token: "dead", pid: child.pid, expiresAt: Date.now() + 60_000 } }));
  await store.upsert(job("expired", { status: "running", lease: { token: "expired", pid: process.pid, expiresAt: Date.now() - 1 }, publication: { stage: "published", skillId: "example", updatedAt: Date.now() } }));
  await store.upsert(job("live", { status: "running", lease: { token: "live", pid: process.pid, expiresAt: Date.now() + 60_000 } }));
  const recovered = await store.recover();
  assert.equal(recovered.recovered, 2);
  assert.deepEqual(recovered.publications.map((item) => item.id), ["expired"]);
  const state = await store.read();
  assert.equal(state.jobs.dead.status, "retry");
  assert.equal(state.jobs.expired.status, "retry");
  assert.equal(state.jobs.live.status, "running");
  assert.equal(await store.finish("expired", "expired", { status: "saved", reason: "stale" }, "saved"), false);
});

test("an abruptly terminated transaction is rolled back by SQLite", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const store = f.store();
  await store.upsert(job());
  const script = `
    const { QueueStore } = await import(${JSON.stringify(new URL("../dist/jobs.js", import.meta.url).href)});
    const store = new QueueStore(${JSON.stringify(f.root)});
    await store.transaction(state => { state.reviews = 77; delete state.jobs['job-1']; process.exit(17); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", windowsHide: true });
  const [code] = await once(child, "exit");
  assert.equal(code, 17);
  assert.equal((await store.read()).reviews, 0);
  assert.ok((await store.read()).jobs["job-1"]);
  await store.transaction((state) => { state.reviews++; });
  assert.equal((await store.read()).reviews, 1);
});

test("project counters remain atomic across processes", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t); const store = f.store();
  await store.read();
  const script = `
    const { QueueStore } = await import(${JSON.stringify(new URL("../dist/jobs.js", import.meta.url).href)});
    const store = new QueueStore(${JSON.stringify(f.root)});
    for (let index = 0; index < 8; index++) await store.transaction(state => { state.reviews++; });
    await store.close();
  `;
  const exits = await Promise.all(Array.from({ length: 4 }, async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore", windowsHide: true });
    return (await once(child, "exit"))[0];
  }));
  assert.deepEqual(exits, [0, 0, 0, 0]);
  assert.equal((await store.read()).reviews, 32);
});

test("legacy JSON counters migrate once and UTC day rollover resets the daily count", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, ".opencode/autoskill");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "state.json"), JSON.stringify({ version: 1, day: new Date().toISOString().slice(0, 10), reviews: 3, sessions: { session: { cursor: "old-id" } }, attempts: {}, recent: [] }));
  const store = f.store();
  assert.equal((await store.read()).reviews, 3);
  assert.equal((await store.read()).sessions.session.cursor, "old-id");
  await store.transaction((state) => { state.day = "2000-01-01"; state.reviews = 99; });
  assert.equal((await store.read()).reviews, 0);
  assert.equal((await store.read()).day, new Date().toISOString().slice(0, 10));
});

test("old completed payloads expire while stable dedup tombstones and every pending task remain", async (t) => {
  const f = await fixture(t); const store = f.store();
  await store.transaction((state) => {
    for (let index = 0; index < 503; index++) state.jobs[`done-${index}`] = job(`done-${index}`, { status: "saved", updatedAt: index });
    state.jobs.pending = job("pending");
    state.jobs.draft = job("draft", { status: "draft" });
  });
  const state = await store.read();
  assert.equal(Object.keys(state.jobs).length, 505);
  assert.equal(state.jobs["done-0"].snapshot, undefined);
  assert.ok(state.jobs["done-502"].snapshot);
  assert.ok(state.jobs.pending.snapshot);
  assert.ok(state.jobs.draft.snapshot);
  assert.equal((await store.upsert(job("done-0"))).inserted, false);
});

test("skip decisions are bounded and observable without retaining raw evidence in the journal", async (t) => {
  const f = await fixture(t); const store = f.store();
  for (let index = 0; index < 205; index++) await store.record("session", { status: "skipped", reason: "Below complexity threshold" }, "complexity_threshold");
  const state = await store.read();
  assert.equal(state.recent.length, 200);
  assert.equal(state.lastDecision!.reasonCode, "complexity_threshold");
  assert.equal(state.metrics!.complexity_threshold, 205);
  assert.doesNotMatch(await fs.readFile(path.join(f.root, ".opencode/autoskill/events.jsonl"), "utf8"), /snapshot|messages/);
});

test("global budget is atomic across project instances and reservation ids are idempotent", async (t) => {
  const f = await fixture(t); const first = f.budget(); const second = f.budget();
  const reserved = await Promise.all(Array.from({ length: 5 }, (_, index) => (index % 2 ? first : second).reserve(`attempt-${index}`, { maxReviewsPerDay: 2, estimatedInputTokens: 10, maxInputTokensPerDay: 100 })));
  assert.equal(reserved.filter((item) => item.allowed).length, 2);
  const allowedIndex = reserved.findIndex((item) => item.allowed);
  const duplicate = await first.reserve(`attempt-${allowedIndex}`, { maxReviewsPerDay: 2, estimatedInputTokens: 10 });
  assert.equal(duplicate.allowed, true);
  assert.equal(duplicate.reasonCode, "budget_already_reserved");
  assert.deepEqual(await second.read(), { day: new Date().toISOString().slice(0, 10), reviews: 2, inputTokens: 20 });
});

test("global estimated input budget denies before exceeding its limit", async (t) => {
  const f = await fixture(t); const store = f.budget();
  assert.equal((await store.reserve("large-attempt", { maxReviewsPerDay: 5, estimatedInputTokens: 90, maxInputTokensPerDay: 100 })).allowed, true);
  const denied = await store.reserve("next-attempt", { maxReviewsPerDay: 5, estimatedInputTokens: 20, maxInputTokensPerDay: 100 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasonCode, "global_daily_input_budget");
  assert.equal((await store.read()).reviews, 1);
  assert.ok(denied.nextRunAt > Date.now());
});
