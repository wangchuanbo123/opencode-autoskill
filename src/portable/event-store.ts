import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { openSqlite, beginImmediate, type SqlDatabase } from "../sqlite.js";
import { ensurePrivateDirectory } from "../state.js";
import { resolveStorageLayout } from "../storage-layout.js";
import { digest, matchesSession } from "../tasks.js";
import { redact, containsSecretValue, sanitizeTool } from "../safety.js";
import type { AutoSkillOptions, TaskSnapshot, ToolRecord } from "../types.js";
import type { HostId, NormalizedHook } from "../adapters/events.js";

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
        db.exec("CREATE TABLE IF NOT EXISTS portable_tasks (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, host TEXT NOT NULL, session TEXT NOT NULL, turn_id TEXT, updated INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS portable_session ON portable_tasks(host,session,updated); CREATE TABLE IF NOT EXISTS hook_receipts (id TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS adapter_observations (host TEXT PRIMARY KEY,value TEXT NOT NULL);");
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
    db.prepare("INSERT INTO portable_tasks(id,token,host,session,turn_id,updated,value) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,value=excluded.value")
      .run(task.id, task.contextToken, task.host, task.nativeSessionId, task.nativeTurnId ?? null, task.updatedAt, JSON.stringify(task));
  }
  private create(host: HostId, session: string, turn: string | undefined, message: string | undefined, prompt: string, trusted: boolean): PortableTask {
    const messageId = message ?? `prompt-${randomUUID()}`;
    const id = digest([host, this.workspaceId, session, turn ?? messageId, digest(prompt)]);
    const sensitive = containsSecretValue(prompt) || this.options.sensitivePatterns.some((literal) => prompt.toLowerCase().includes(literal.toLowerCase()));
    const text = safeText(prompt, this.root, this.options).slice(0, 20_000);
    return { id, contextToken: randomUUID(), host, nativeSessionId: session, nativeTurnId: turn, messageId, queryHash: digest(text), prompt: text, sensitive,
      trusted, snapshot: { sessionId: id, directory: this.root, hostId: host, workspaceId: this.workspaceId, turnId: turn, origin: { kind: "user" },
        messages: [{ id: messageId, role: "user", text, tools: [], createdAt: Date.now() }], terminal: "unknown", executionCompleted: false },
      ended: false, captured: false, coverage: [], createdAt: Date.now(), updatedAt: Date.now() };
  }
  async accept(event: NormalizedHook): Promise<{ task?: PortableTask; duplicate?: boolean; reasonCode?: string }> {
    if (await fs.realpath(event.cwd) !== await fs.realpath(this.root)) return { reasonCode: "project_out_of_scope" };
    if (matchesSession(event.sessionId, this.options.excludeSessions)) return { reasonCode: "session_excluded" };
    return this.transaction((db) => {
      db.prepare("INSERT INTO adapter_observations(host,value) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET value=excluded.value")
        .run(event.host, JSON.stringify({ lastEventAt: Date.now(), eventName: event.eventName, coverage: event.coverage }));
      if (event.origin === "maintenance" || event.origin === "subagent" || event.kind === "subagent-start" || event.kind === "subagent-end") return { reasonCode: "internal_or_child_event" };
      const rows = db.prepare("SELECT value FROM portable_tasks WHERE host=? AND session=? ORDER BY updated DESC LIMIT 12").all(event.host, event.sessionId);
      const known = rows.map((row) => this.decode(row)!);
      let task = event.turnId ? known.find((item) => item.nativeTurnId === event.turnId) : known[0];
      if (event.kind === "task-start") {
        const prompt = event.prompt!;
        if (task && !task.ended && task.prompt === safeText(prompt, this.root, this.options).slice(0, 20_000) && (!event.messageId || task.messageId === event.messageId)) return { task, duplicate: true };
        const prior = task;
        task = this.create(event.host, event.sessionId, event.turnId, event.messageId, prompt, event.host !== "generic");
        if (prior && !prior.ended) {
          prior.ended = true; prior.snapshot.terminal = "interrupted"; prior.snapshot.executionCompleted = false;
          prior.coverage.push("superseded_before_completion"); this.save(db, prior);
          if (!event.turnId) task.coverage.push("ambiguous_previous_execution");
        }
        this.save(db, task); return { task };
      }
      if (!task) return { reasonCode: "task_context_missing" };
      if (event.kind === "ignored" && !event.assistantText) return { task, reasonCode: "ignored_event" };
      if (!event.turnId && task.coverage.includes("ambiguous_previous_execution") && event.kind === "tool-result") return { task, reasonCode: "ambiguous_task_event" };
      if (task.ended && event.kind === "tool-result") return { task, reasonCode: "late_tool_event" };
      const nativeTool = event.tool?.nativeCallId;
      const receipt = digest([event.host, task.id, event.eventId ?? [event.eventName, nativeTool ?? event.tool?.name, event.tool?.input, event.tool?.output, event.assistantText, event.terminal]]);
      if (db.prepare("SELECT id FROM hook_receipts WHERE id=?").get(receipt)) return { task, duplicate: true };
      db.prepare("INSERT INTO hook_receipts(id,at) VALUES(?,?)").run(receipt, Date.now());
      if (event.tool) {
        const safe = sanitizeTool(event.tool, { root: this.root, excludeTools: this.options.excludeTools, excludeFiles: this.options.excludeFiles, sensitivePatterns: this.options.sensitivePatterns });
        if (safe && !safe.name.startsWith("autoskill_") && !/mcp.*autoskill/.test(safe.name)) {
          const tool: ToolRecord = { ...safe, id: digest([task.id, nativeTool ?? receipt]), output: safeText(safe.output, this.root, this.options).slice(0, this.options.maxToolOutputChars) };
          const existing = task.snapshot.messages.find((message) => message.tools.some((item) => item.id === tool.id));
          if (existing) existing.tools = [tool];
          else if (task.snapshot.messages.length < 258) task.snapshot.messages.push({ id: `tool-${tool.id}`, role: "assistant", text: "", tools: [tool], completedAt: Date.now() });
          else task.coverage.push("tool_count_budget");
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
    return this.transaction((db) => { const task = this.create(host, `mcp-${randomUUID()}`, undefined, undefined, prompt, false); this.save(db, task); return task; });
  }
  async get(id: string): Promise<PortableTask | undefined> { const db = await this.database(); return this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(id)); }
  async token(token: string, host: HostId): Promise<PortableTask | undefined> { const db = await this.database(); return this.decode(db.prepare("SELECT value FROM portable_tasks WHERE token=? AND host=?").get(token, host)); }
  async pending(host?: HostId): Promise<PortableTask[]> {
    const db = await this.database(); const rows = host ? db.prepare("SELECT value FROM portable_tasks WHERE host=? ORDER BY updated LIMIT 2000").all(host) : db.prepare("SELECT value FROM portable_tasks ORDER BY updated LIMIT 2000").all();
    return rows.map((row) => this.decode(row)!).filter((task) => task.ended && !task.captured);
  }
  async captured(id: string): Promise<void> { await this.transaction((db) => { const task = this.decode(db.prepare("SELECT value FROM portable_tasks WHERE id=?").get(id)); if (task) { task.captured = true; this.save(db, task); } }); }
  async status(): Promise<unknown> {
    const db = await this.database(); const counts = db.prepare("SELECT host,COUNT(*) AS tasks FROM portable_tasks GROUP BY host").all();
    return { hosts: counts, pendingEvidence: (await this.pending()).length, observations: db.prepare("SELECT host,value FROM adapter_observations").all().map((row) => ({ host: (row as {host: string}).host, ...JSON.parse((row as {value: string}).value) })) };
  }
  async close(): Promise<void> { await this.serial; if (this.opening) (await this.opening).close(); }
}
