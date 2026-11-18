import type { Plugin } from "@opencode/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AutoSkillEngine } from "../../engine.js";
import { digest, matchesSession } from "../../tasks.js";
import type { ConversationMessage, EnginePort, ExistingSkill, HostCapabilities, TaskSnapshot, ToolRecord } from "../../types.js";
import { resolveStorageLayout } from "../../storage-layout.js";
import { readPortableConfig, readSafeFile, sha256 } from "../../portable/install.js";
import { SkillStore } from "../../skills.js";
import { sqliteBusy } from "../../sqlite.js";

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
type SessionRecords = Awaited<ReturnType<Plugin.Context["session"]["context"]>>;
type AssistantRecord = Extract<SessionRecords[number], { type: "assistant" }>;
type AssistantTool = Extract<AssistantRecord["content"][number], { type: "tool" }>;

export type AdapterEngine = Pick<AutoSkillEngine, "schedule" | "review" | "status" | "dispose"> & {
  prepareReuse?(input: { sessionId: string; messageId: string; text: string; signal?: AbortSignal }): Promise<void>;
  reuseContext?(sessionId: string, signal?: AbortSignal, messageId?: string, queryHash?: string, originalText?: string): Promise<{ text: string; candidateIds: string[]; catalog?: { id: string; description: string; hostIds?: string[] }[] } | undefined>;
  loadReuse?(input: { sessionId: string; skillId: string; signal?: AbortSignal }): Promise<unknown>;
  searchReuse?(input: { sessionId: string; query: string; signal?: AbortSignal }): Promise<unknown>;
  reuseFeedback?(input: { sessionId: string; skillId: string; outcome: "success" | "failure" | "unknown"; used?: boolean; signal?: AbortSignal }): Promise<unknown>;
};
export type EngineFactory = (port: EnginePort) => AdapterEngine;

/** Recognize exact, unchanged native exports without taking ownership of user files. */
export async function resolveManagedSkillAliases(root: string, skills: ExistingSkill[]): Promise<ExistingSkill[]> {
  if (resolveStorageLayout(root).kind !== "portable") return skills;
  try {
    const text = await readSafeFile(path.join(root, ".autoskill", "exports", "opencode.json"));
    if (!text) return skills;
    const manifest = JSON.parse(text);
    if (manifest.schemaVersion !== 1 || manifest.host !== "opencode" || !manifest.skills || typeof manifest.skills !== "object" || Array.isArray(manifest.skills)) return skills;
    const managed = (await new SkillStore(root).list()).filter(skill => skill.ownership === "managed" && !skill.archived);
    const aliases = new Map<string, { path: string; hash: string }>();
    for (const [id, record] of Object.entries(manifest.skills)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !record || typeof record !== "object") continue;
      const entry = record as { file?: unknown; sourceHash?: unknown; exportHash?: unknown };
      const expectedRelative = path.join(".opencode", "skills", id, "SKILL.md");
      if (typeof entry.file !== "string" || path.normalize(entry.file) !== expectedRelative) continue;
      const source = managed.find(skill => skill.id === id && skill.sha256 === entry.sourceHash && entry.exportHash === entry.sourceHash);
      if (!source) continue;
      const file = path.join(root, expectedRelative), content = await readSafeFile(file, 256_000);
      if (content !== undefined && sha256(content) === source.sha256) aliases.set(path.resolve(file), { path: source.path, hash: source.sha256 });
    }
    return skills.map(skill => {
      const alias = aliases.get(path.resolve(skill.path));
      return alias && (skill.content === undefined || sha256(skill.content) === alias.hash) ? { ...skill, path: alias.path } : skill;
    });
  } catch { return skills; }
}

/** Guard the experimental API contract before starting background work. */
export function detectCapabilities(ctx: Plugin.Context): HostCapabilities {
  const hostVersion = typeof ctx.app?.version === "string" ? ctx.app.version : undefined;
  const version = hostVersion && /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(hostVersion);
  const missing = [
    ["session.get", ctx.session?.get], ["session.context", ctx.session?.context],
    ["experimental.generate.text", ctx.experimental?.generate?.text],
    ["skill.list", ctx.skill?.list], ["skill.reload", ctx.skill?.reload],
    ["event.subscribe", ctx.event?.subscribe], ["tool.transform", ctx.tool?.transform],
  ].filter(([, value]) => typeof value !== "function").map(([name]) => String(name));
  if (!version || Number(version[1]) !== 2 || Number(version[2]) !== 2 || Number(version[3]) < 7) {
    missing.push("host.version: requires >=2.2.7 <2.3.0");
  }
  return { hostVersion, supported: missing.length === 0, missing };
}

/** Reuse has an independent admission/context API contract; distillation can remain available. */
export function detectReuseCapabilities(ctx: Plugin.Context): HostCapabilities {
  const base = detectCapabilities(ctx);
  const missing = [["session.hook", ctx.session?.hook], ["session.get", ctx.session?.get],
    ["session.context", ctx.session?.context], ["tool.transform", ctx.tool?.transform]]
    .filter(([, value]) => typeof value !== "function").map(([name]) => String(name));
  missing.push(...base.missing.filter((name) => name.startsWith("host.version:")));
  return { hostVersion: base.hostVersion, supported: missing.length === 0, missing };
}

/** Only remove recognized, exact-ID managed entries; preserve all external skills and unknown formats. */
export function filterManagedSkillCatalog(text: string, managedIds: ReadonlySet<string>): string {
  if (!managedIds.size) return text;
  const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[entity]!));
  return text.replace(/<available_skills>([\s\S]*?)<\/available_skills>/g, (block, body: string) => {
    const rows = [...body.matchAll(/<skill>([\s\S]*?)<\/skill>/g)];
    if (!rows.length || body.replace(/<skill>[\s\S]*?<\/skill>/g, "").trim()) return block;
    let parsed = true;
    const ids = new Map<number, string>();
    for (const row of rows) {
      const fields = [...row[1]!.matchAll(/<(id|name|description)>([^<]*)<\/\1>/g)];
      if (row[1]!.replace(/<(id|name|description)>[^<]*<\/\1>/g, "").trim() ||
          fields.filter((field) => field[1] === "id").length !== 1 || fields.filter((field) => field[1] === "name").length !== 1 ||
          fields.length !== new Set(fields.map((field) => field[1])).size) { parsed = false; break; }
      ids.set(row.index!, decode(fields.find((field) => field[1] === "id")![2]!).trim());
    }
    if (!parsed) return block;
    let output = body;
    for (const row of rows.reverse()) if (managedIds.has(ids.get(row.index!)!)) output = output.slice(0, row.index) + output.slice(row.index! + row[0].length);
    return `<available_skills>${output}</available_skills>`;
  });
}

/** Some local host methods lack request options; cancellation still bounds our wait. */
async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

async function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(signal, () => new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref(); })); }
  finally { if (timer) clearTimeout(timer); }
}

/** Keep diagnostics useful without exposing error messages, paths or host-provided fields. */
function reuseFailureCategory(error: unknown, signal: AbortSignal): string {
  const item = error as { name?: unknown; code?: unknown } | undefined;
  if (signal.aborted || item?.name === "AbortError" || item?.name === "TimeoutError") {
    return (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError" || item?.name === "TimeoutError" ? "timeout" : "aborted";
  }
  if (sqliteBusy(error)) return "sqlite_busy";
  switch (item?.code) {
    case "EACCES": return "eacces";
    case "EPERM": return "eperm";
    case "ENOENT": return "enoent";
    case "ENOTDIR": return "enotdir";
    case "ELOOP": return "eloop";
    case "ENOSPC": return "enospc";
    case "EIO": return "eio";
    case "EROFS": return "erofs";
    case "EMFILE": return "emfile";
    case "ENFILE": return "enfile";
    case "EBUSY": return "ebusy";
    default: return "operation_failed";
  }
}

function toolRecord(tool: AssistantTool): ToolRecord {
  const state = tool.state;
  // `executed` is provider execution metadata, not the outcome of local tool execution.
  const status = state.status === "completed" ? "completed" : state.status === "error" ? "error" : "pending";
  const content = state.status === "completed" || state.status === "error" ? state.content : undefined;
  const text = content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
  const error = state.status === "error" ? state.error.message : "";
  return {
    id: tool.id,
    name: tool.name,
    status,
    input: state.input,
    output: [text, error].filter(Boolean).join("\n"),
  };
}

/** Convert the public V2 transcript, excluding reasoning, native metadata and attachments. */
export function normalizeSnapshot(info: SessionInfo, records: SessionRecords, _terminal: TaskSnapshot["terminal"]): TaskSnapshot {
  const messages: ConversationMessage[] = [];
  // A manual review runs inside a new execution. Only the last completed execution is eligible.
  const completedAt = info.time.idle;
  if (completedAt === undefined || !info.outcome) throw new Error("This session has no completed execution to review.");
  for (const record of records) {
    if (record.time.created > completedAt) continue;
    if (record.type === "user") {
      messages.push({ id: record.id, role: "user", text: record.text, tools: [], createdAt: record.time.created });
    } else if (record.type === "assistant") {
      if (record.time.completed !== undefined && record.time.completed > completedAt) continue;
      messages.push({
        id: record.id,
        role: "assistant",
        text: record.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        tools: record.content.filter((part) => part.type === "tool").map(toolRecord),
        finish: record.finish,
        error: record.error?.message,
        createdAt: record.time.created,
        completedAt: record.time.completed,
      });
    } else if (record.type === "shell") {
      const finished = record.time.completed !== undefined && record.time.completed <= completedAt;
      const status = !finished || record.status === "running" ? "pending" : record.status === "exited" && record.exit === 0 ? "completed" : "error";
      messages.push({
        id: record.id,
        role: "assistant",
        text: "",
        createdAt: record.time.created,
        completedAt: finished ? record.time.completed : undefined,
        tools: [{
          id: record.shellID,
          name: "shell",
          status,
          input: { command: record.command },
          output: finished ? `${record.exit !== undefined ? `Exit code: ${record.exit}\n` : ""}${record.output?.output ?? ""}` : "",
        }],
      });
    }
  }
  // The persisted outcome is authoritative when a delayed event arrives after another execution.
  const actualTerminal = info.outcome === "succeeded" ? "success" : info.outcome === "failed" ? "failure" : "interrupted";
  return {
    sessionId: info.id,
    directory: info.location.directory,
    messages,
    terminal: actualTerminal,
    model: info.model ? { providerID: info.model.providerID, id: info.model.id } : undefined,
    parentId: info.parentID,
    agent: info.agent,
  };
}

/** Public setup seam for testing against the same V2 surface used by OpenCode. */
export async function setupAdapter(ctx: Plugin.Context, createEngine: EngineFactory = (port) => new AutoSkillEngine(port)): Promise<Plugin.Cleanup> {
  const controller = new AbortController();
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const capabilities = detectCapabilities(ctx);
  const reuseCapabilities = detectReuseCapabilities(ctx);
  const portable = resolveStorageLayout(ctx.location.directory).kind === "portable";
  const shared = portable ? await readPortableConfig(ctx.location.directory) : undefined;
  const effectiveOptions: Record<string, unknown> = { ...(shared?.options ?? {}), ...(shared ? { agentPolicy: shared.agentPolicy } : {}), ...ctx.options,
    ...(shared?.adapters.opencode?.enabled === false ? { enabled: false } : {}) };
  const port: EnginePort = {
    root: ctx.location.directory,
    hostId: portable ? "opencode" : undefined,
    workspaceId: portable ? await fs.realpath(ctx.location.directory) : undefined,
    compatibilityHostId: "opencode",
    hostCapabilities: [
      ["opencode.session.get", ctx.session?.get], ["opencode.session.context", ctx.session?.context], ["opencode.session.hook", ctx.session?.hook],
      ["opencode.experimental.generate.text", ctx.experimental?.generate?.text], ["opencode.skill.list", ctx.skill?.list], ["opencode.skill.reload", ctx.skill?.reload],
      ["opencode.tool.transform", ctx.tool?.transform], ["opencode.event.subscribe", ctx.event?.subscribe],
    ].filter(([, value]) => typeof value === "function").map(([name]) => String(name)),
    options: effectiveOptions,
    capabilities,
    reuseCapabilities,
    async snapshot(sessionId, terminal, signal) {
      const usedSignal = signalFor(signal);
      const [info, records] = await abortable(usedSignal, () => Promise.all([
        ctx.session.get({ sessionID: sessionId }, { signal: usedSignal }),
        ctx.session.context({ sessionID: sessionId }, { signal: usedSignal }),
      ]));
      const snapshot = normalizeSnapshot(info, records, terminal);
      return portable ? { ...snapshot, hostId: port.hostId, workspaceId: port.workspaceId, executionCompleted: true,
        origin: { kind: info.agent?.startsWith("autoskill") ? "reviewer" : info.parentID ? "subagent" : "user" } } : snapshot;
    },
    async generate({ prompt, model, signal }) {
      const usedSignal = signalFor(signal);
      const result = await abortable(usedSignal, () => ctx.experimental.generate.text({ prompt, model }, { signal: usedSignal }));
      return result.text;
    },
    async listSkills(signal) {
      const usedSignal = signalFor(signal);
      const result = await abortable(usedSignal, () => ctx.skill.list({ location: { directory: ctx.location.directory } }, { signal: usedSignal }));
      const skills = result.data.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? "",
        path: skill.path,
        content: skill.content,
        // The store independently checks ownership before updating a file.
        managed: false,
      }));
      return resolveManagedSkillAliases(ctx.location.directory, skills);
    },
    async reloadSkills(signal) { await abortable(signalFor(signal), () => ctx.skill.reload()); },
    log(level, message) { console[level](`[opencode-autoskill] ${message}`); },
  };
  const engine = createEngine(port);
  if (!capabilities.supported) port.log("warn", `Automatic reviews are disabled: ${capabilities.missing.join(", ")}.`);
  let tools: { dispose(): Promise<void> | void } = { dispose() {} };
  const reuseRegistrations: { dispose(): Promise<void> | void }[] = [];
  const reuseEnabled = effectiveOptions.enabled !== false && effectiveOptions.reuseEnabled !== false;
  const reuseSupported = reuseEnabled && reuseCapabilities.supported && typeof engine.prepareReuse === "function" && typeof engine.reuseContext === "function";
  const hookWork = new Set<Promise<void>>();
  const hookDeadline = typeof effectiveOptions.reuseTimeoutMs === "number" ? Math.max(100, Math.min(30_000, effectiveOptions.reuseTimeoutMs)) : 5_000;
  const inReuseScope = async (sessionId: string, signal: AbortSignal) => {
    if (matchesSession(sessionId, Array.isArray(effectiveOptions.excludeSessions) ? effectiveOptions.excludeSessions as string[] : [])) return false;
    const info = await abortable(signal, () => ctx.session.get({ sessionID: sessionId as SessionInfo["id"] }, { signal }));
    if (info.parentID && effectiveOptions.agentPolicy !== "independent" || info.agent?.startsWith("autoskill")) return false;
    const [root, directory] = await abortable(signal, () => Promise.all([fs.realpath(ctx.location.directory), fs.realpath(info.location.directory)]));
    return root === directory;
  };
  const runHook = (stage: "prompt" | "context", operation: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException("AutoSkill reuse timed out", "TimeoutError")), hookDeadline);
    const signal = AbortSignal.any([controller.signal, deadline.signal]);
    const promise = abortable(signal, () => operation(signal)).catch((error: unknown) => {
      if (!controller.signal.aborted) port.log("warn", `Skill reuse was unavailable for this request; continuing the task without additional skill context. hook=${stage} reason=${reuseFailureCategory(error, signal)} elapsedMs=${Math.max(0, Math.round(performance.now() - started))}`);
    }).finally(() => { clearTimeout(timer); hookWork.delete(promise); });
    hookWork.add(promise); return promise;
  };
  try {
    if (typeof ctx.tool?.transform === "function") tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "autoskill_status",
        description: "Show AutoSkill background review status, budget and recent results.",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          context.signal.throwIfAborted();
          return { content: JSON.stringify(await abortable(signalFor(context.signal), () => engine.status()), null, 2) };
        },
      });
      editor.add({
        name: "autoskill_review",
        description: "Review unprocessed tasks up to this session's last completed boundary. dryRun generates a review draft without publishing a skill. force bypasses only the complexity threshold; evidence, quality and budget checks still apply.",
        options: { codemode: false },
        input: { type: "object", properties: { force: { type: "boolean", default: false }, dryRun: { type: "boolean", default: false } }, additionalProperties: false },
        async execute(input, context) {
          context.signal.throwIfAborted();
          const force = !!input && typeof input === "object" && "force" in input && input.force === true;
          const dryRun = !!input && typeof input === "object" && "dryRun" in input && input.dryRun === true;
          return { content: JSON.stringify(await engine.review(context.sessionID, force, signalFor(context.signal), dryRun), null, 2) };
        },
      });
      if (reuseSupported && engine.searchReuse) editor.add({
        name: "autoskill_search",
        description: "Search the project AutoSkill library using a more specific task query when the current shortlist is insufficient. Returns bounded summaries without loading bodies, executing instructions or changing the current user task. Respect the user's exclusions and project constraints.",
        options: { codemode: false },
        input: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 1500 } }, required: ["query"], additionalProperties: false },
        async execute(input, context) {
          context.signal.throwIfAborted();
          if (!input || typeof input !== "object" || !("query" in input) || typeof input.query !== "string" || !input.query.trim() || input.query.length > 1500) throw new Error("A query of 1–1500 characters is required.");
          if (!await inReuseScope(context.sessionID, signalFor(context.signal))) return { content: JSON.stringify({ status: "unavailable", reasonCode: "session_out_of_scope" }) };
          return { content: JSON.stringify(await abortable(signalFor(context.signal), () => engine.searchReuse!({ sessionId: context.sessionID, query: input.query as string, signal: signalFor(context.signal) })), null, 2) };
        },
      });
      if (reuseSupported && engine.loadReuse) editor.add({
        name: "autoskill_load",
        description: "Load a shortlisted AutoSkill candidate for the current task after checking its applicability. Loading provides instructions and does not execute them, establish actual use, or prove success. Follow the current user request, environment and permissions.",
        options: { codemode: false },
        input: { type: "object", properties: { skillId: { type: "string", minLength: 1, maxLength: 128 } }, required: ["skillId"], additionalProperties: false },
        async execute(input, context) {
          context.signal.throwIfAborted();
          if (!input || typeof input !== "object" || !("skillId" in input) || typeof input.skillId !== "string") throw new Error("skillId is required.");
          if (!await inReuseScope(context.sessionID, signalFor(context.signal))) return { content: JSON.stringify({ status: "unavailable", reasonCode: "session_out_of_scope" }) };
          return { content: JSON.stringify(await abortable(signalFor(context.signal), () => engine.loadReuse!({ sessionId: context.sessionID, skillId: input.skillId as string, signal: signalFor(context.signal) })), null, 2) };
        },
      });
      if (reuseSupported && engine.reuseFeedback) editor.add({
        name: "autoskill_feedback",
        description: "Report whether a loaded AutoSkill was actually used and its local outcome. This is model-reported feedback, kept separate from verified user feedback. Loading alone is not usage; session success does not establish that the skill caused success. Use unknown when the effect is unclear.",
        options: { codemode: false },
        input: { type: "object", properties: { skillId: { type: "string", minLength: 1, maxLength: 128 }, used: { type: "boolean" }, outcome: { type: "string", enum: ["success", "failure", "unknown"] } }, required: ["skillId", "used", "outcome"], additionalProperties: false },
        async execute(input, context) {
          context.signal.throwIfAborted();
          if (!input || typeof input !== "object" || !("skillId" in input) || typeof input.skillId !== "string" || !("used" in input) || typeof input.used !== "boolean" ||
              !("outcome" in input) || !["success", "failure", "unknown"].includes(String(input.outcome))) throw new Error("skillId, used and outcome are required.");
          if (!await inReuseScope(context.sessionID, signalFor(context.signal))) return { content: JSON.stringify({ status: "unavailable", reasonCode: "session_out_of_scope" }) };
          return { content: JSON.stringify(await abortable(signalFor(context.signal), () => engine.reuseFeedback!({ sessionId: context.sessionID, skillId: input.skillId as string,
            used: input.used as boolean, outcome: input.outcome as "success" | "failure" | "unknown", signal: signalFor(context.signal) })), null, 2) };
        },
      });
    });
    if (reuseSupported) {
      reuseRegistrations.push(await ctx.session.hook("prompt", (input) => runHook("prompt", async (signal) => {
        if (!await inReuseScope(input.sessionID, signal)) return;
        await engine.prepareReuse!({ sessionId: input.sessionID, messageId: input.messageID, text: input.prompt.text, signal });
      })));
      reuseRegistrations.push(await ctx.session.hook("context", (input) => runHook("context", async (signal) => {
        if (input.agent.startsWith("autoskill") || !await inReuseScope(input.sessionID, signal)) return;
        const user = [...input.messages].reverse().find((message) => message.role === "user");
        const messageId = user?.id;
        // Admission can queue a newer user task while this context still belongs to the previous task.
        if (!messageId) return;
        // V2.2.7 retains the admitted prompt as its first text part and appends
        // rendered file/skill attachments afterward. Attachments are not revisions.
        const queryHash = digest(user!.content.find((part) => part.type === "text")?.text ?? "");
        const reused = await engine.reuseContext!(input.sessionID, signal, messageId, queryHash, user!.content.find((part) => part.type === "text")?.text ?? "");
        signal.throwIfAborted();
        input.system = input.system.filter((part) => part.metadata?.autoskillReuse !== true);
        if (!reused) return;
        const ids = new Set((reused.catalog ?? []).flatMap((skill) => [skill.id, ...(skill.hostIds ?? [])]));
        input.system = input.system.map((part) => ({ ...part, text: filterManagedSkillCatalog(part.text, ids) }));
        for (const tool of Object.values(input.tools)) tool.description = filterManagedSkillCatalog(tool.description, ids);
        if (reused.text.trim()) input.system.push({ type: "text", text: reused.text, metadata: { autoskillReuse: true } });
      })));
    } else if (reuseEnabled && typeof engine.prepareReuse === "function") port.log("warn", `Automatic skill reuse is unavailable: ${reuseCapabilities.missing.join(", ") || "engine context API"}.`);
  } catch (error) {
    controller.abort();
    await Promise.allSettled([tools.dispose(), ...reuseRegistrations.map((registration) => registration.dispose()), ...hookWork]);
    await engine.dispose();
    throw error;
  }
  const pump = (async () => {
    let retryMs = 250;
    while (capabilities.supported && !controller.signal.aborted) {
      let iterator: AsyncIterator<{ type: string; data: { sessionID: string } }> | undefined;
      try {
        iterator = ctx.event.subscribe({
        types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"],
        signal: controller.signal,
        })[Symbol.asyncIterator]();
        while (!controller.signal.aborted) {
          const item = await abortable(controller.signal, () => iterator!.next());
          if (item.done) break;
          const event = item.value;
          retryMs = 250;
          const terminal = event.type === "session.execution.succeeded" ? "success" : event.type === "session.execution.failed" ? "failure" : event.type === "session.execution.interrupted" ? "interrupted" : "idle";
          engine.schedule(event.data.sessionID, terminal);
        }
      } catch { /* A disconnected or failed stream is retried below. */ }
      finally {
        try { if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined); }
        catch { /* A broken stream's cleanup must not prevent reconnection. */ }
      }
      if (!controller.signal.aborted) {
        port.log("warn", `OpenCode events disconnected; reconnecting in ${retryMs}ms.`);
        try { await reconnectDelay(retryMs, controller.signal); } catch { break; }
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  })();
  let cleanup: Promise<unknown> | undefined;
  return async () => {
    controller.abort();
    cleanup ??= Promise.allSettled([engine.dispose(), tools.dispose(), ...reuseRegistrations.map((registration) => registration.dispose()), ...hookWork, pump]);
    await cleanup;
  };
}

export default { id: "opencode-autoskill", setup: setupAdapter } satisfies Plugin.Plugin;
