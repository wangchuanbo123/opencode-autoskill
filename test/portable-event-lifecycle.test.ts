import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { EventStore, EXPLICIT_CONTEXT_TTL_MS, cleanEventEvidence } from "../dist/portable/event-store.js";
import { normalizeHook } from "../dist/adapters/events.js";
import { readOptions } from "../dist/config.js";

async function fixture(t) {
  const tempBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempBase, "autoskill-event-lifecycle-"));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill/config.json"), "{}\n");
  let events = new EventStore(root, readOptions());
  t.after(async () => {
    await events.close();
    assert.equal(path.dirname(root), tempBase);
    assert.ok(path.basename(root).startsWith("autoskill-event-lifecycle-"));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, get events() { return events; }, async reopen(change?) {
    const file = events.file; await events.close();
    if (change) { const db = new DatabaseSync(file); try { change(db); } finally { db.close(); } }
    events = new EventStore(root, readOptions());
  } };
}

test("cross-process captured and delivered bookkeeping cannot move the active Gemini turn", async (t) => {
  const f = await fixture(t), base = { session_id: "native-session", cwd: f.root };
  const first = await f.events.accept(normalizeHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "Inspect invoice cache" }));
  await f.events.accept(normalizeHook("gemini", { ...base, hook_event_name: "AfterAgent", prompt_response: "Cache inspection finished" }));
  const second = await f.events.accept(normalizeHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "Inspect database migration" }));
  const other = new EventStore(f.root, readOptions());
  try { await other.captured(first.task.id); await other.delivered(first.task.id); } finally { await other.close(); }
  const tool = { ...base, tool_name: "read_file", tool_input: { file_path: "migration.sql" } };
  const before = await f.events.accept(normalizeHook("gemini", { ...tool, hook_event_name: "BeforeTool" }));
  const result = await f.events.accept(normalizeHook("gemini", { ...tool, hook_event_name: "AfterTool", tool_response: { llmContent: "Migration holds an exclusive lock" } }));
  const stop = await f.events.accept(normalizeHook("gemini", { ...base, hook_event_name: "AfterAgent", prompt_response: "Migration diagnosis finished" }));
  assert.equal(before.task.id, second.task.id); assert.equal(result.task.id, second.task.id);
  assert.equal(stop.task.id, second.task.id); assert.equal(stop.task.ended, true);
  assert.equal(stop.task.snapshot.messages.flatMap(message => message.tools).length, 1);
  await f.reopen();
  assert.equal((await f.events.current("gemini", base.session_id)).id, second.task.id);
});

test("stable start identity survives long history without resetting evidence, tokens or active execution", async (t) => {
  const f = await fixture(t), base = { session_id: "long-session", cwd: f.root };
  const input = { ...base, turn_id: "first", hook_event_name: "UserPromptSubmit", prompt: "Inspect the first module" };
  const first = await f.events.accept(normalizeHook("codex", input));
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "first", hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "call-first", tool_input: {}, tool_response: "First module evidence" }));
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "first", hook_event_name: "Stop", last_assistant_message: "First module complete" }));
  let latest;
  for (let i = 1; i <= 20; i++) {
    latest = await f.events.accept(normalizeHook("codex", { ...base, turn_id: `turn-${i}`, hook_event_name: "UserPromptSubmit", prompt: `Inspect module ${i}` }));
    await f.events.accept(normalizeHook("codex", { ...base, turn_id: `turn-${i}`, hook_event_name: "Stop", last_assistant_message: `Module ${i} complete` }));
  }
  await f.reopen();
  const replay = await f.events.accept(normalizeHook("codex", input));
  assert.equal(replay.duplicate, true); assert.equal(replay.task.ended, true);
  assert.equal(replay.task.contextToken, first.task.contextToken);
  assert.equal(replay.task.snapshot.messages.flatMap(message => message.tools).length, 1);
  assert.equal((await f.events.token(replay.task.contextToken, "codex")).id, first.task.id);
  assert.equal((await f.events.current("codex", base.session_id)).id, latest.task.id);
  const delayed = await f.events.accept(normalizeHook("codex", { ...base, turn_id: "first", hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "call-first", tool_input: {}, tool_response: "A delayed old result" }));
  assert.equal(delayed.task.id, first.task.id); assert.equal(delayed.reasonCode, "late_tool_event");
});

test("native tool IDs reused in another turn cannot override its explicit task identity", async (t) => {
  const f = await fixture(t), base = { session_id: "native-id-reuse", cwd: f.root, tool_use_id: "call-1", tool_name: "Read", tool_input: {} };
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "one", hook_event_name: "UserPromptSubmit", prompt: "Inspect first module" }));
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "one", hook_event_name: "PostToolUse", tool_response: "First module" }));
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "one", hook_event_name: "Stop", last_assistant_message: "Finished" }));
  const second = await f.events.accept(normalizeHook("codex", { ...base, turn_id: "two", hook_event_name: "UserPromptSubmit", prompt: "Inspect second module" }));
  const result = await f.events.accept(normalizeHook("codex", { ...base, turn_id: "two", hook_event_name: "PostToolUse", tool_response: "Second module" }));
  assert.equal(result.task.id, second.task.id);
  assert.equal(result.task.snapshot.messages.flatMap(message => message.tools)[0].output, "Second module");
});

test("legacy migration recovers creation order and the originally issued SQL token", async (t) => {
  const f = await fixture(t), base = { session_id: "legacy-session", cwd: f.root };
  const first = await f.events.accept(normalizeHook("codex", { ...base, turn_id: "one", hook_event_name: "UserPromptSubmit", prompt: "Inspect first module" }));
  await f.events.accept(normalizeHook("codex", { ...base, turn_id: "one", hook_event_name: "Stop" }));
  const second = await f.events.accept(normalizeHook("codex", { ...base, turn_id: "two", hook_event_name: "UserPromptSubmit", prompt: "Inspect second module" }));
  const explicit = await f.events.explicit("generic", "Inspect a migration lock");
  await f.reopen(db => {
    db.exec("DROP TABLE portable_sessions; DROP TABLE portable_tool_owners; PRAGMA user_version=0;");
    db.prepare("UPDATE portable_tasks SET updated=?,value=json_set(value,'$.contextToken',?) WHERE id=?").run(Date.now() + 100_000, "11111111-1111-4111-8111-111111111111", first.task.id);
    db.exec("UPDATE portable_tasks SET value=json_remove(value,'$.source','$.lastUsedAt','$.expiresAt');");
  });
  assert.equal((await f.events.current("codex", base.session_id)).id, second.task.id);
  assert.equal((await f.events.token(first.task.contextToken, "codex")).contextToken, first.task.contextToken);
  assert.equal(await f.events.token("11111111-1111-4111-8111-111111111111", "codex"), undefined);
  const restored = await f.events.token(explicit.contextToken, "generic");
  assert.equal(restored.source, "explicit-mcp"); assert.ok(restored.expiresAt > Date.now());
});

test("explicit query tokens slide within their idle TTL and expired queries are removable", async (t) => {
  const f = await fixture(t); let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const query = await f.events.explicit("generic", "Inspect migration locks");
  assert.equal(query.expiresAt, now + EXPLICIT_CONTEXT_TTL_MS);
  now += EXPLICIT_CONTEXT_TTL_MS - 1;
  const refreshed = await f.events.token(query.contextToken, "generic");
  assert.equal(refreshed.lastUsedAt, now); assert.equal(refreshed.expiresAt, now + EXPLICIT_CONTEXT_TTL_MS);
  now += EXPLICIT_CONTEXT_TTL_MS;
  assert.equal(await f.events.token(query.contextToken, "generic"), undefined);
  assert.ok(await f.events.get(query.id), "expiry rejects the token before physical cleanup");
  assert.deepEqual(await cleanEventEvidence(f.root, { olderThanDays: 365, dryRun: true }), { tasks: 1, receipts: 0 });
  assert.ok(await f.events.get(query.id));
  assert.deepEqual(await cleanEventEvidence(f.root, { olderThanDays: 365 }), { tasks: 1, receipts: 0 });
  assert.equal(await f.events.get(query.id), undefined);
});

test("explicit retention cleanup leaves unfinished and uncaptured host evidence intact", async (t) => {
  const f = await fixture(t); let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const query = await f.events.explicit("generic", "Inspect migration locks");
  const pending = await f.events.accept(normalizeHook("gemini", { session_id: "unfinished", cwd: f.root, hook_event_name: "BeforeAgent", prompt: "Inspect a pending request" }));
  const done = await f.events.accept(normalizeHook("gemini", { session_id: "uncaptured", cwd: f.root, hook_event_name: "BeforeAgent", prompt: "Inspect another request" }));
  await f.events.accept(normalizeHook("gemini", { session_id: "uncaptured", cwd: f.root, hook_event_name: "AfterAgent" }));
  now += 1;
  const result = await cleanEventEvidence(f.root, { olderThanDays: 0 });
  assert.equal(result.tasks, 1); assert.equal(await f.events.get(query.id), undefined);
  assert.ok(await f.events.get(pending.task.id)); assert.ok(await f.events.get(done.task.id));
});

test("disabled EventStore rejects capture and explicit contexts before opening its database", async (t) => {
  const f = await fixture(t), disabled = new EventStore(f.root, readOptions({ enabled: false }));
  try {
    const result = await disabled.accept(normalizeHook("gemini", { session_id: "disabled", cwd: f.root, hook_event_name: "BeforeAgent", prompt: "Private disabled request" }));
    assert.deepEqual(result, { reasonCode: "disabled" });
    await assert.rejects(disabled.explicit("generic", "Private disabled query"), /disabled/);
    await assert.rejects(fs.access(disabled.file), { code: "ENOENT" });
  } finally { await disabled.close(); }
});

test("cleaned host evidence retains only its stable start tombstone and cannot be replayed", async (t) => {
  const f = await fixture(t); let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const input = { session_id: "cleaned-host", cwd: f.root, turn_id: "turn", hook_event_name: "UserPromptSubmit", prompt: "Inspect a bounded migration failure" };
  const start = await f.events.accept(normalizeHook("codex", input));
  await f.events.accept(normalizeHook("codex", { ...input, hook_event_name: "Stop" }));
  await f.events.captured(start.task.id); now += 1;
  assert.equal((await cleanEventEvidence(f.root, { olderThanDays: 0 })).tasks, 1);
  await f.reopen();
  const replay = await f.events.accept(normalizeHook("codex", input));
  assert.deepEqual(replay, { duplicate: true, reasonCode: "task_evidence_expired" });
  assert.equal(await f.events.get(start.task.id), undefined);
  assert.equal(await f.events.current("codex", input.session_id), undefined);
});

test("cleanup before legacy migration retains host tombstones, expires old queries, and leaves dry runs untouched", async (t) => {
  const f = await fixture(t); let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const input = { session_id: "legacy-clean", cwd: f.root, turn_id: "turn", hook_event_name: "UserPromptSubmit", prompt: "Inspect a legacy migration failure" };
  const host = await f.events.accept(normalizeHook("codex", input));
  await f.events.accept(normalizeHook("codex", { ...input, hook_event_name: "Stop" }));
  await f.events.captured(host.task.id);
  const explicit = await f.events.explicit("generic", "Inspect a legacy MCP query");
  await f.reopen(db => {
    db.exec("DROP TABLE portable_sessions; DROP TABLE portable_tool_owners; DROP TABLE portable_start_ids; PRAGMA user_version=0;");
    db.exec("UPDATE portable_tasks SET value=json_remove(value,'$.source','$.lastUsedAt','$.expiresAt');");
  });
  now += 1;
  const database = f.events.file;
  assert.equal((await cleanEventEvidence(f.root, { olderThanDays: 0, dryRun: true })).tasks, 2);
  const before = new DatabaseSync(database);
  try {
    assert.equal(before.prepare("SELECT name FROM sqlite_master WHERE name='portable_start_ids'").get(), undefined);
    assert.equal(before.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(before.prepare("SELECT COUNT(*) AS n FROM portable_tasks").get().n, 2);
  } finally { before.close(); }
  assert.equal((await cleanEventEvidence(f.root, { olderThanDays: 0 })).tasks, 2);
  const after = new DatabaseSync(database);
  try {
    assert.ok(after.prepare("SELECT id FROM portable_start_ids WHERE id=?").get(host.task.id));
    assert.equal(after.prepare("SELECT id FROM portable_start_ids WHERE id=?").get(explicit.id), undefined);
  } finally { after.close(); }
  assert.deepEqual(await f.events.accept(normalizeHook("codex", input)), { duplicate: true, reasonCode: "task_evidence_expired" });
  assert.equal(await f.events.get(host.task.id), undefined); assert.equal(await f.events.get(explicit.id), undefined);
});

test("legacy migration selects the newest created execution independently for thousands of historical rows", async (t) => {
  const f = await fixture(t);
  const sample = (await f.events.accept(normalizeHook("codex", { session_id: "seed", cwd: f.root, turn_id: "seed", hook_event_name: "UserPromptSubmit", prompt: "Inspect migration history" }))).task;
  const at = Date.now();
  await f.reopen(db => {
    db.exec("DROP TABLE portable_sessions; DROP TABLE portable_tool_owners; DROP TABLE portable_start_ids; DELETE FROM portable_tasks; PRAGMA user_version=0; BEGIN;");
    try {
      const insert = db.prepare("INSERT INTO portable_tasks(id,token,host,session,turn_id,updated,value) VALUES(?,?,?,?,?,?,?)");
      for (let i = 0; i < 3_000; i++) {
        const task = { ...sample, id: `historical-${i}`, contextToken: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          nativeSessionId: i === 2_999 ? "other-session" : "bulk-session", nativeTurnId: `turn-${i}`, ended: true, captured: true,
          createdAt: i === 1_777 ? at + 100_000 : at + i, updatedAt: i === 7 ? at + 1_000_000 : at - i,
          snapshot: { ...sample.snapshot, sessionId: `historical-${i}`, messages: [] } };
        delete task.source;
        insert.run(task.id, task.contextToken, task.host, task.nativeSessionId, task.nativeTurnId, task.updatedAt, JSON.stringify(task));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  });
  const started = performance.now();
  const bulk = await f.events.current("codex", "bulk-session");
  t.diagnostic(`Migrated 3000 historical executions in ${Math.round(performance.now() - started)}ms.`);
  assert.equal(bulk.id, "historical-1777");
  assert.equal((await f.events.current("codex", "other-session")).id, "historical-2999");
  assert.equal((await f.events.token(bulk.contextToken, "codex")).id, bulk.id);
  assert.equal((await f.events.status()).hosts[0].tasks, 3_000);
});
