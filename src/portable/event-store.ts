import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqlite, beginImmediate, assertSqliteFiles, type SqlDatabase } from "../sqlite.js";
import { ensurePrivateDirectory } from "../state.js";
import { resolveStorageLayout } from "../storage-layout.js";
import { digest, matchesSession } from "../tasks.js";
import { redact, containsSecretValue, sanitizeTool } from "../safety.js";
import type { AutoSkillOptions, TaskSnapshot, ToolRecord } from "../types.js";
import type { HostId, NormalizedHook } from "../adapters/events.js";
import { QueueStore } from "../jobs.js";

/** Explicit MCP contexts expire after 24 hours without an authenticated token use. */
export const EXPLICIT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface PortableTask {
  id: string;
  contextToken: string;
  host: HostId;
  nativeSessionId: string;
  nativeTurnId?: string;
  messageId: string;
  queryHash: string;
  prompt: string;
  sensitive: boolean;
  snapshot: TaskSnapshot;
  ended: boolean;
  captured: boolean;
  trusted: boolean;
  source: "host" | "explicit-mcp";
  lastUsedAt?: number;
  expiresAt?: number;
  contextDelivered?: boolean;
  coverage: string[];
  createdAt: number;
  updatedAt: number;
}

function safeText(value: string, root: string, options: AutoSkillOptions): string {
  let text = redact(value, root);
  for (const literal of options.sensitivePatterns) text = text.replace(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted-sensitive]");
  return text;
}

/** Hook receipts and task evidence are private, with short cross-process transactions. */
export class EventStore {
  private opening?: Promise<SqlDatabase>;
  private serial: Promise<unknown> = Promise.resolve();
  readonly file: string;
  readonly workspaceId: string;
  constructor(readonly root: string, private options: AutoSkillOptions) {
    this.file = path.join(resolveStorageLayout(root).stateRoot, "events.sqlite");
    this.workspaceId = digest(path.resolve(root));
  }
  private async database(): Promise<SqlDatabase> {
    this.opening ??= (async () => {
      const db = await openSqlite(this.file, () => ensurePrivateDirectory(this.root));
      try {
        if (!await beginImmediate(db)) throw new Error("AutoSkill events are busy.");
        db.exec("CREATE TABLE IF NOT EXISTS portable_tasks (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, host TEXT NOT NULL, session TEXT NOT NULL, turn_id TEXT, updated INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS portable_session ON portable_tasks(host,session,updated); CREATE INDEX IF NOT EXISTS portable_turn ON portable_tasks(host,session,turn_id); CREATE TABLE IF NOT EXISTS hook_receipts (id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS adapter_observations (host TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS portable_sessions (host TEXT NOT NULL, session TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(host,session)); CREATE TABLE IF NOT EXISTS portable_tool_owners (host TEXT NOT NULL, session TEXT NOT NULL, call_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(host,session,call_id,task_id)); CREATE TABLE IF NOT EXISTS portable_start_ids (id TEXT PRIMARY KEY);");
        const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (version < 2) {
          // Repair old token/JSON divergence without revoking the originally issued SQL token.
          db.exec("UPDATE portable_tasks SET value=json_set(value,'$.contextToken',token) WHERE json_extract(value,'$.contextToken') IS NOT token;");
          db.prepare("UPDATE portable_tasks SET value=json_set(value,'$.source',CASE WHEN json_extract(value,'$.trusted')=0 AND session LIKE 'mcp-%' THEN 'explicit-mcp' ELSE 'host' END)").run();
          db.prepare("UPDATE portable_tasks SET value=json_set(value,'$.lastUsedAt',updated,'$.expiresAt',updated+?) WHERE json_extract(value,'$.source')='explicit-mcp'").run(EXPLICIT_CONTEXT_TTL_MS);
          // Old bookkeeping writes changed `updated`; creation order is the best recoverable execution order.
          db.exec("INSERT OR IGNORE INTO portable_sessions(host,session,task_id) SELECT host,session,id FROM (SELECT host,session,id,ROW_NUMBER() OVER(PARTITION BY host,session ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC) AS execution_rank FROM portable_tasks) WHERE execution_rank=1;");
          db.exec("INSERT OR IGNORE INTO portable_tool_owners(host,session,call_id,task_id) SELECT p.host,p.session,json_extract(t.value,'$.nativeCallId'),p.id FROM portable_tasks p,json_each(p.value,'$.snapshot.messages') m,json_each(m.value,'$.tools') t WHERE json_type(t.value,'$.nativeCallId')='text';");
        }
        if (version < 3) db.exec("INSERT OR IGNORE INTO portable_start_ids(id) SELECT id FROM portable_tasks WHERE json_extract(value,'$.source')='host'; PRAGMA user_version=3;");
        db.exec("COMMIT"); return db;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); throw error; }
    })().catch((error) => { this.opening = undefined; throw error; });
    return this.opening;
  }
  private transaction<T>(fn: (db: SqlDatabase) => T): Promise<T> {
    const work = this.serial.then(async () => {
      const db = await this.database(); if (!await beginImmediate(db)) throw new Error("AutoSkill events are busy.");
      try { const result = fn(db); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
    this.serial = work.catch(() => undefined); return work;
  }
  private decode(row: unknown): PortableTask | undefined { return row ? JSON.parse((row as { value: string }).value) as PortableTask : undefined; }
  private save(db: SqlDatabase, task: PortableTask): void {
    task.updatedAt = Date.now();
    if (JSON.stringify(task).length > 1_000_000) throw new Error("Task event evidence exceeds the private storage budget.");
    db.prepare("INSERT INTO portable_tasks(id,token,host,session,turn_id,updated,value) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,updated=excluded.updated,value=excluded.value")
      .run(task.id, task.contextToken, task.host, task.nativeSessionId, task.nativeTurnId ?? null, task.updatedAt, JSON.stringify(task));
  }
  private create(host: HostId, session: string, turn: string | undefined, message: string | undefined, prompt: string, trusted: boolean): PortableTask {
    const messageId = message ?? `prompt-${randomUUID()}`;
    const id = digest([host, this.workspaceId, session, turn ?? messageId, digest(prompt)]);
    const sensitive = containsSecretValue(prompt) || this.options.sensitivePatterns.some((literal) => prompt.toLowerCase().includes(literal.toLowerCase()));
    const text = safeText(prompt, this.root, this.options).slice(0, 20_000);
    return { id, contextToken: randomUUID(), host, nativeSessionId: session, nativeTurnId: turn, messageId, queryHash: digest(text), prompt: text, sensitive,
      trusted, source: "host", snapshot: { sessionId: id, directory: this.root, hostId: host, workspaceId: this.workspaceId, turnId: turn, origin: { kind: "user" },
        revision: digest(prompt), messages: [{ id: messageId, role: "user", text, tools: [], createdAt: Date.now() }], terminal: "unknown", executionCompleted: false },
      ended: false, captured: false, coverage: prompt.length > 20_000 ? ["prompt_truncated"] : [], createdAt: Date.now(), updatedAt: Date.now() };
  }
  async accept(event: NormalizedHook): Promise<{ task?: PortableTask; duplicate?: boolean; reasonCode?: string; invalidatedTaskIds?: string[] }> {
    if (!this.options.enabled) return { reasonCode: "disabled" };
    const relative = path.relative(await fs.realpath(this.root), await fs.realpath(event.cwd));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { reasonCode: "project_out_of_scope" };
    if (matchesSession(event.sessionId, this.options.excludeSessions)) return { reasonCode: "session_excluded" };
    return this.transaction((db) => {
      db.prepare("INSERT INTO adapter_observations(host,value) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET value=excluded.value")
        .run(event.host, JSON.stringify({ lastEventAt: Date.now(), eventName: event.eventName, coverage: event.coverage }));
      if (event.origin === "maintenance" || event.origin === "subagent" || event.kind === "subagent-start" || event.kind === "subagent-end") return { reasonCode: "internal_or_child_event" };
      const current = this.decode(db.prepare("SELECT p.value FROM portable_sessions s JOIN portable_tasks p ON p.id=s.task_id WHERE s.host=? AND s.session=?").get(event.host, event.sessionId));
      const known = event.turnId ? db.prepare("SELECT value FROM portable_tasks WHERE host=? AND session=? AND turn_id=? ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC")
        .all(event.host, event.sessionId, event.turnId).map((row) => this.decode(row)!) : current ? [current] : [];
      let task = event.messageId ? known.find((item) => item.messageId === event.messageId) ?? known[0] : known[0];
      if (event.kind === "task-start") {
        const prompt = event.prompt!;
        const stable = event.turnId ?? event.messageId;
        const stableId = stable ? digest([event.host, this.workspaceId, event.sessionId, stable, digest(prompt)]) : undefined;
        const previous = stableId ? this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(stableId)) : undefined;
        if (previous) return { task: previous, duplicate: true };
        if (stableId && db.prepare("SELECT id FROM portable_start_ids WHERE id=?").get(stableId)) return { duplicate: true, reasonCode: "task_evidence_expired" };
        const samePrompt = task && task.prompt === safeText(prompt, this.root, this.options).slice(0, 20_000) && (!event.messageId || task.messageId === event.messageId);
        if (!stable && samePrompt && !task!.ended) return { task, duplicate: true };
        const prior = task ?? current;
        task = this.create(event.host, event.sessionId, event.turnId, event.messageId, prompt, event.host !== "generic");
        task.coverage = [...new Set([...task.coverage, ...event.coverage.reasons])];
        const revision = prior && ((event.turnId && prior.nativeTurnId === event.turnId) || (event.messageId && prior.messageId === event.messageId));
        if (prior && (!prior.ended || revision)) {
          prior.ended = true; prior.snapshot.terminal = "interrupted"; prior.snapshot.executionCompleted = false;
          prior.captured = false; prior.coverage.push("superseded_before_completion"); this.save(db, prior);
          if (!event.turnId) task.coverage.push("ambiguous_previous_execution");
        }
        this.save(db, task);
        db.prepare("INSERT OR IGNORE INTO portable_start_ids(id) VALUES(?)").run(task.id);
        db.prepare("INSERT INTO portable_sessions(host,session,task_id) VALUES(?,?,?) ON CONFLICT(host,session) DO UPDATE SET task_id=excluded.task_id").run(event.host, event.sessionId, task.id);
        return { task, ...(prior?.coverage.includes("superseded_before_completion") ? { invalidatedTaskIds: [prior.id] } : {}) };
      }
      if (event.kind === "tool-result" && event.tool?.nativeCallId && !task?.snapshot.messages.some((message) => message.tools.some((tool) => tool.nativeCallId === event.tool!.nativeCallId))) {
        const sql = "SELECT p.value FROM portable_tool_owners o JOIN portable_tasks p ON p.id=o.task_id WHERE o.host=? AND o.session=? AND o.call_id=?" + (event.turnId ? " AND p.turn_id=?" : "") + " ORDER BY json_extract(p.value,'$.createdAt') DESC,p.rowid DESC LIMIT 1";
        const owner = this.decode(db.prepare(sql).get(event.host, event.sessionId, event.tool.nativeCallId, ...(event.turnId ? [event.turnId] : [])));
        if (owner) task = owner;
      }
      if (!task) return { reasonCode: "task_context_missing" };
      if (task.sensitive) return { task, reasonCode: "sensitive_task_excluded" };
      if (event.kind === "ignored" && !event.assistantText) return { task, reasonCode: "ignored_event" };
      if (!event.turnId && task.coverage.includes("ambiguous_previous_execution") && event.kind === "tool-result") return { task, reasonCode: "ambiguous_task_event" };
      if (task.ended && (event.kind === "tool-result" || event.kind === "tool-start")) return { task, reasonCode: "late_tool_event" };
      if (task.ended && ["interrupted", "failure"].includes(task.snapshot.terminal) && event.kind === "task-end" && !["interrupted", "failure"].includes(event.terminal ?? "unknown")) return { task, reasonCode: "terminal_boundary_sealed" };
      if (event.kind === "task-end" && event.turnId && !event.messageId && known.filter((item) => item.nativeTurnId === event.turnId).length > 1) return { task, reasonCode: "ambiguous_revision_boundary" };
      const nativeTool = event.tool?.nativeCallId;
      const receipt = digest([event.host, task.id, event.eventId ?? [event.eventName, nativeTool ?? event.tool?.name, event.tool?.input, event.tool?.output, event.assistantText, event.terminal]]);
      if (db.prepare("SELECT id FROM hook_receipts WHERE id=?").get(receipt)) return { task, duplicate: true };
      db.prepare("INSERT INTO hook_receipts(id,at) VALUES(?,?)").run(receipt, Date.now());
      if (event.tool) {
        const safe = sanitizeTool(event.tool, { root: this.root, excludeTools: this.options.excludeTools, excludeFiles: this.options.excludeFiles, sensitivePatterns: this.options.sensitivePatterns });
        if (safe && !safe.name.startsWith("autoskill_") && !/mcp.*autoskill/.test(safe.name)) {
          // Some hosts omit call IDs. A completion may resolve only an observed
          // pending call with the same name and input; unmatched results remain
          // separate receipts and retain the coverage limitation.
          const pending = !nativeTool && event.kind === "tool-result" ? [...task.snapshot.messages].reverse().flatMap((message) => message.tools)
            .find((tool) => tool.status === "pending" && tool.name === safe.name && digest(tool.input) === digest(safe.input)) : undefined;
          const tool: ToolRecord = { ...safe, id: pending?.id ?? digest([task.id, nativeTool ?? receipt]), output: safeText(safe.output, this.root, this.options).slice(0, this.options.maxToolOutputChars) };
          const existing = task.snapshot.messages.find((message) => message.tools.some((item) => item.id === tool.id));
          if (existing) existing.tools = [tool];
          else if (task.snapshot.messages.length < 258) task.snapshot.messages.push({ id: `tool-${tool.id}`, role: "assistant", text: "", tools: [tool], completedAt: Date.now() });
          else task.coverage.push("tool_count_budget");
          if (nativeTool) db.prepare("INSERT OR IGNORE INTO portable_tool_owners(host,session,call_id,task_id) VALUES(?,?,?,?)").run(event.host, event.sessionId, nativeTool, task.id);
        } else task.coverage.push("tool_excluded");
      }
      if (event.assistantText) {
        const text = safeText(event.assistantText, this.root, this.options).slice(0, 5_000);
        const prior = task.snapshot.messages.find((message) => message.id === "assistant-final");
        if (prior) prior.text = text;
        else task.snapshot.messages.push({ id: "assistant-final", role: "assistant", text, tools: [], completedAt: Date.now() });
      }
      if (event.kind === "task-end") {
        task.ended = true; task.captured = false; task.snapshot.terminal = event.terminal ?? "unknown";
        task.snapshot.executionCompleted = event.executionCompleted === true;
      }
      task.coverage = [...new Set([...task.coverage, ...event.coverage.reasons])]; this.save(db, task);
      return { task };
    });
  }
  async explicit(host: HostId, prompt: string): Promise<PortableTask> {
    if (!this.options.enabled) throw new Error("AutoSkill is disabled; explicit query contexts are unavailable.");
    return this.transaction((db) => {
      const task = this.create(host, `mcp-${randomUUID()}`, undefined, undefined, prompt, false);
      task.source = "explicit-mcp"; task.lastUsedAt = Date.now(); task.expiresAt = task.lastUsedAt + EXPLICIT_CONTEXT_TTL_MS;
      this.save(db, task); return task;
    });
  }
  async get(id: string): Promise<PortableTask | undefined> { const db = await this.database(); return this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(id)); }
  async current(host: HostId, session: string): Promise<PortableTask | undefined> { const db = await this.database(); return this.decode(db.prepare("SELECT p.value FROM portable_sessions s JOIN portable_tasks p ON p.id=s.task_id WHERE s.host=? AND s.session=?").get(host, session)); }
  async token(token: string, host: HostId): Promise<PortableTask | undefined> {
    return this.transaction((db) => {
      const task = this.decode(db.prepare("SELECT value FROM portable_tasks WHERE token=? AND host=?").get(token, host));
      if (task?.source === "explicit-mcp") {
        const now = Date.now(); if (!task.expiresAt || task.expiresAt <= now) return undefined;
        task.lastUsedAt = now; task.expiresAt = now + EXPLICIT_CONTEXT_TTL_MS; this.save(db, task);
      }
      return task;
    });
  }
  async pending(host?: HostId): Promise<PortableTask[]> {
    const db = await this.database(); const rows = host ? db.prepare("SELECT value FROM portable_tasks WHERE host=? AND json_extract(value,'$.ended')=1 AND json_extract(value,'$.captured')=0 ORDER BY updated LIMIT 2000").all(host) : db.prepare("SELECT value FROM portable_tasks WHERE json_extract(value,'$.ended')=1 AND json_extract(value,'$.captured')=0 ORDER BY updated LIMIT 2000").all();
    return rows.map((row) => this.decode(row)!).filter((task) => task.ended && !task.captured);
  }
  async captured(id: string): Promise<void> { await this.transaction((db) => { const task = this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(id)); if (task) { task.captured = true; this.save(db, task); } }); }
  async delivered(id: string): Promise<void> { await this.transaction((db) => { const task = this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(id)); if (task) { task.contextDelivered = true; this.save(db, task); } }); }
  async status(): Promise<unknown> {
    const db = await this.database(); const counts = db.prepare("SELECT host,COUNT(*) AS tasks FROM portable_tasks GROUP BY host").all();
    return { hosts: counts, pendingEvidence: (await this.pending()).length, explicitContextIdleTtlMs: EXPLICIT_CONTEXT_TTL_MS, observations: db.prepare("SELECT host,value FROM adapter_observations").all().map((row) => ({ host: (row as {host: string}).host, ...JSON.parse((row as {value: string}).value) })) };
  }
  async close(): Promise<void> { await this.serial; if (this.opening) (await this.opening).close(); }
}

/** Expire captured host evidence and idle explicit queries; never remove pending work. */
export async function cleanEventEvidence(root: string, options: { olderThanDays?: number; dryRun?: boolean } = {}): Promise<{ tasks: number; receipts: number }> {
  const days = options.olderThanDays ?? 30;
  if (!Number.isFinite(days) || days < 0) throw new Error("olderThanDays must be nonnegative.");
  const file = path.join(resolveStorageLayout(root).stateRoot, "events.sqlite");
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe event evidence database."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: 0, receipts: 0 }; throw error; }
  await assertSqliteFiles(file);
  const cutoff = Date.now() - days * 86_400_000;
  const protectedTasks = new Set<string>();
  try {
    const queueFile = path.join(resolveStorageLayout(root).stateRoot, "runtime.sqlite");
    await fs.access(queueFile);
    const queue = new QueueStore(root);
    try { for (const job of Object.values((await queue.read()).jobs)) if (!["saved", "skipped", "failed", "cancelled"].includes(job.status)) protectedTasks.add(job.snapshot?.sessionId ?? job.sessionId); }
    finally { await queue.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const moduleName = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun:sqlite" : "node:sqlite";
  const driver = await import(moduleName);
  const native = moduleName === "bun:sqlite" ? new driver.Database(file, { readonly: !!options.dryRun }) : new driver.DatabaseSync(file, { readOnly: !!options.dryRun });
  const db: SqlDatabase = { exec: (sql) => native.exec(sql), prepare: (sql) => moduleName === "bun:sqlite" ? native.query(sql) : native.prepare(sql), close: () => native.close() };
  let locked = false;
  try {
    if (!options.dryRun) { locked = await beginImmediate(db); if (!locked) throw new Error("Event evidence is busy."); }
    const expired = (db.prepare("SELECT id,CASE WHEN json_extract(value,'$.source')='explicit-mcp' OR (json_extract(value,'$.trusted')=0 AND session LIKE 'mcp-%') THEN 0 ELSE 1 END AS hostTask FROM portable_tasks WHERE (updated < ? AND json_extract(value,'$.ended')=1 AND json_extract(value,'$.captured')=1) OR ((json_extract(value,'$.source')='explicit-mcp' OR (json_extract(value,'$.trusted')=0 AND session LIKE 'mcp-%')) AND (COALESCE(json_extract(value,'$.lastUsedAt'),updated) < ? OR COALESCE(json_extract(value,'$.expiresAt'),updated+?) <= ?))")
      .all(cutoff, cutoff, EXPLICIT_CONTEXT_TTL_MS, Date.now()) as { id: string; hostTask: number }[]).filter((item) => !protectedTasks.has(item.id));
    const tasks = expired.length;
    const receipts = (db.prepare("SELECT COUNT(*) AS count FROM hook_receipts WHERE at < ?").get(cutoff) as { count: number }).count;
    if (!options.dryRun) {
      // Cleanup may be the first command after upgrading an old events database.
      // Preserve host identities in the same transaction before removing their evidence.
      db.exec("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS portable_start_ids (id TEXT PRIMARY KEY);");
      const owners = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portable_tool_owners'").get();
      for (const item of expired) {
        if (item.hostTask) db.prepare("INSERT OR IGNORE INTO portable_start_ids(id) VALUES(?)").run(item.id);
        if (owners) db.prepare("DELETE FROM portable_tool_owners WHERE task_id=?").run(item.id);
        db.prepare("DELETE FROM portable_tasks WHERE id=?").run(item.id);
      }
      db.prepare("DELETE FROM hook_receipts WHERE at < ?").run(cutoff);
      db.exec("COMMIT"); locked = false;
    }
    return { tasks, receipts };
  } finally { if (locked) db.exec("ROLLBACK"); db.close(); }
}
