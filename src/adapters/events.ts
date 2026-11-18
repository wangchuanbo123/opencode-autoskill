import { createHash, randomUUID } from "node:crypto";
import type { ToolRecord } from "../types.js";
import { normalizeClaudeCode, CLAUDE_CODE_CAPABILITIES } from "./claude-code.js";
import { normalizeCodex, CODEX_CAPABILITIES } from "./codex.js";
import { normalizeGemini, GEMINI_CAPABILITIES } from "./gemini.js";
import { normalizeCursor, CURSOR_CAPABILITIES } from "./cursor.js";

export type HostId = "claude-code" | "codex" | "gemini" | "cursor" | "generic";
export type HookKind = "task-start" | "tool-start" | "tool-result" | "task-end" | "session-start" | "subagent-start" | "subagent-end" | "ignored";
export interface HookCoverage {
  source: "hook";
  transcript: "not-read";
  tools: "observed" | "partial" | "none";
  reasons: string[];
}
export interface NormalizedHook {
  host: HostId;
  sessionId: string;
  turnId?: string;
  messageId?: string;
  cwd: string;
  eventId?: string;
  kind: HookKind;
  eventName: string;
  prompt?: string;
  assistantText?: string;
  tool?: ToolRecord;
  terminal?: "success" | "failure" | "interrupted" | "unknown";
  /** Execution ended; does not establish task completion or successful verification. */
  executionCompleted?: boolean;
  origin?: "user" | "subagent" | "maintenance" | "unknown";
  parentId?: string;
  agentId?: string;
  coverage: HookCoverage;
}
export interface AdapterCapabilities {
  host: HostId;
  hooks: readonly string[];
  promptContextInjection: boolean;
  sessionContextInjection: boolean;
  toolEvidence: boolean;
  taskBoundary: boolean;
  nativeSkillDirectory?: string;
  refresh: "watch" | "reload-command" | "next-session" | "none";
  limitations: readonly string[];
}
export type HookInput = Record<string, unknown>;
export const MAX_HOOK_TEXT = 64_000;

export function record(value: unknown): HookInput | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as HookInput : undefined;
}
export function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}
export function boundedText(value: unknown, limit = MAX_HOOK_TEXT): string | undefined {
  return typeof value === "string" ? value.replaceAll("\0", "").slice(0, limit) : undefined;
}
export function inputRecord(value: unknown): HookInput {
  const input = record(value);
  if (!input) throw new Error("Hook input must be a JSON object.");
  return input;
}

/** Keep only bounded JSON data. Never preserve hidden reasoning or encoded media. */
export function boundedValue(value: unknown): unknown {
  let remaining = MAX_HOOK_TEXT;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 2_000 || depth > 8 || remaining <= 0) return "[truncated]";
    if (typeof item === "string") { const result = item.replaceAll("\0", "").slice(0, remaining); remaining -= result.length; return result; }
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object") return null;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => visit(child, depth + 1));
    const output: HookInput = Object.create(null);
    for (const [key, child] of Object.entries(item).slice(0, 100)) {
      if (/^(?:__proto__|prototype|constructor|reasoning|thinking|signature|base64|image|image_url|data)$/i.test(key)) continue;
      remaining -= key.length;
      if (remaining <= 0) break;
      output[key.slice(0, 200)] = visit(child, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function decodeOutput(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_HOOK_TEXT) return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function toolOutput(value: unknown): string {
  const decoded = decodeOutput(value);
  if (typeof decoded === "string") return boundedText(decoded) ?? "";
  const obj = record(decoded);
  if (!obj) return decoded === undefined || decoded === null ? "" : JSON.stringify(boundedValue(decoded));
  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "text", "message"]) if (typeof obj[key] === "string") parts.push(obj[key] as string);
  for (const key of ["content", "llmContent"]) {
    if (typeof obj[key] === "string") parts.push(obj[key] as string);
    else if (Array.isArray(obj[key])) for (const part of obj[key] as unknown[]) {
      const item = record(part);
      if (item && (item.type === undefined || item.type === "text") && typeof item.text === "string") parts.push(item.text);
    }
  }
  const error = record(obj.error);
  if (typeof obj.error === "string") parts.push(obj.error);
  else if (typeof error?.message === "string") parts.push(error.message);
  const exit = obj.exit_code ?? obj.exitCode ?? obj.exit;
  if (typeof exit === "number") parts.unshift(`Exit code: ${exit}`);
  return boundedText(parts.length ? [...new Set(parts)].join("\n") : JSON.stringify(boundedValue(obj))) ?? "";
}

export function baseHook(host: HostId, input: HookInput, session?: unknown, turn?: unknown): NormalizedHook {
  const sessionId = identifier(session ?? input.session_id);
  if (!sessionId) throw new Error(`Invalid ${host} hook session identifier.`);
  const eventName = identifier(input.hook_event_name ?? input.event_name ?? input.kind);
  if (!eventName) throw new Error(`Invalid ${host} hook event name.`);
  const cwd = boundedText(input.cwd, 32_768);
  if (cwd === undefined || !cwd.trim() || typeof input.cwd !== "string" || input.cwd.length > 32_768 || input.cwd.includes("\0")) throw new Error(`Invalid ${host} hook working directory.`);
  const turnId = identifier(turn ?? input.turn_id ?? input.prompt_id);
  const agentId = identifier(input.agent_id);
  const parentId = identifier(input.parent_session_id ?? input.parent_thread_id ?? input.parent_id);
  return { host, sessionId, turnId, messageId: identifier(input.message_id ?? input.prompt_id), cwd, eventName,
    eventId: identifier(input.hook_event_id ?? input.event_id), kind: "ignored", agentId, parentId,
    origin: hookOrigin(input), coverage: { source: "hook", transcript: "not-read", tools: "none", reasons: [] } };
}
export function hookOrigin(input: HookInput): NormalizedHook["origin"] {
  const source = input.source ?? input.origin ?? input.prompt_source;
  // Agent IDs can identify a root agent on other hosts. Only explicit ancestry
  // or source metadata establishes child origin in this shared normalizer.
  if (input.is_subagent === true || input.parent_session_id || input.parent_thread_id || input.parent_id || /subagent|teammate|agent[-_ ]report/i.test(String(source ?? ""))) return "subagent";
  if (/schedule|cron|loop|internal|maintenance|continuation|hook/i.test(String(source ?? ""))) return "maintenance";
  if (source === "user" || source === "human") return "user";
  return "unknown";
}
export function taskStart(event: NormalizedHook, input: HookInput): NormalizedHook {
  if (event.origin === "maintenance" || event.origin === "subagent") {
    event.coverage.reasons.push("non_user_prompt");
    return event;
  }
  event.prompt = boundedText(input.prompt ?? input.user_input ?? input.text);
  if (event.prompt === undefined || !event.prompt.trim()) { event.coverage.reasons.push("missing_prompt"); return event; }
  if (typeof (input.prompt ?? input.user_input ?? input.text) === "string" && String(input.prompt ?? input.user_input ?? input.text).length > MAX_HOOK_TEXT) event.coverage.reasons.push("prompt_truncated");
  event.kind = "task-start";
  event.origin = "user";
  return event;
}

export function normalizedTool(event: NormalizedHook, input: HookInput, output: unknown, failed = false): NormalizedHook {
  const name = identifier(input.tool_name ?? input.name);
  if (!name) { event.coverage.reasons.push("missing_tool_name"); return event; }
  const nativeId = identifier(input.tool_use_id ?? input.tool_call_id ?? input.call_id);
  const decoded = decodeOutput(output);
  const obj = record(decoded);
  const metadata = record(obj?.metadata);
  const nativeExit = obj?.exit_code ?? obj?.exitCode ?? obj?.exit ?? metadata?.exit_code ?? metadata?.exitCode;
  const renderedExit = typeof decoded === "string" ? /(?:^|\n)(?:Process exited with code |Exit code:\s*)(-?\d+)(?:\s|$)/.exec(decoded) : undefined;
  const exit = typeof nativeExit === "number" ? nativeExit : renderedExit ? Number(renderedExit[1]) : undefined;
  const error = obj?.error;
  const interrupted = input.is_interrupt === true || obj?.interrupted === true;
  const execute = toolCategory(name) === "execute";
  const asyncProcess = execute && exit === undefined && (obj?.session_id !== undefined && obj.session_id !== null || obj?.backgroundTaskId || obj?.background_task_id ||
    typeof decoded === "string" && /(?:^|\n)(?:Process running with session ID |Script running with cell ID |(?:Command )?running in (?:the )?background)/i.test(decoded));
  const status: ToolRecord["status"] = failed || interrupted || obj?.isError === true || typeof exit === "number" && exit !== 0 || error !== undefined && error !== null && error !== false && error !== "" ? "error"
    : asyncProcess || obj?.status === "running" || obj?.status === "pending" || obj?.status === "in_progress" || obj?.redacted === true || output === undefined || output === null ? "pending" : "completed";
  const identity = nativeId ?? `unidentified-${randomUUID()}`;
  const id = `${event.host}:${createHash("sha256").update(JSON.stringify([event.sessionId, event.turnId ?? "", event.agentId ?? "", identity])).digest("hex")}`;
  const outputText = toolOutput(output);
  const errorText = boundedText(input.error_message ?? input.error);
  event.kind = "tool-result";
  event.tool = { id, name, nativeName: name, nativeCallId: nativeId, sourceEventId: event.eventId, category: toolCategory(name), status,
    input: boundedValue(input.tool_input ?? input.arguments ?? input.input ?? {}), output: [outputText, errorText].filter(Boolean).join("\n").slice(0, MAX_HOOK_TEXT) };
  event.coverage.tools = nativeId && output !== undefined && obj?.redacted !== true ? "observed" : "partial";
  if (!nativeId) event.coverage.reasons.push("missing_tool_call_id");
  if (output === undefined && !errorText) event.coverage.reasons.push("missing_tool_output");
  if (obj?.redacted === true) event.coverage.reasons.push("tool_output_redacted");
  if (asyncProcess) event.coverage.reasons.push("process_still_running");
  if (typeof output === "string" && output.length > MAX_HOOK_TEXT) event.coverage.reasons.push("tool_output_truncated");
  return event;
}

/** Categories describe observed operations. A test-looking name never proves verification. */
export function toolCategory(name: string): ToolRecord["category"] {
  const native = name.toLowerCase();
  if (/^(?:bash|shell|powershell|exec_command|execute_command|run_shell_command|run_command|write_stdin)$/.test(native)) return "execute";
  if (/^(?:read|read_file|readfile|view_file|view_image|list_directory|list_files)$/.test(native)) return "read";
  if (/^(?:write|edit|delete|write_file|edit_file|replace|replace_in_file|apply_patch|patch)$/.test(native)) return "write";
  if (/^(?:grep|glob|search|search_file_content|list_code_definition_names|web_search)$/.test(native)) return "search";
  return "other";
}
export function normalizedToolStart(event: NormalizedHook, input: HookInput): NormalizedHook {
  const result = normalizedTool(event, input, undefined);
  if (result.tool) { result.kind = "tool-start"; result.tool.status = "pending"; result.coverage.reasons = result.coverage.reasons.filter((reason) => reason !== "missing_tool_output"); }
  return result;
}
export function subagentHook(event: NormalizedHook, ending = false): NormalizedHook {
  event.kind = ending ? "subagent-end" : "subagent-start";
  event.origin = "subagent";
  if (!event.parentId) event.coverage.reasons.push("parent_id_unavailable");
  if (!event.agentId) event.coverage.reasons.push("agent_id_unavailable");
  if (ending) { event.terminal = "unknown"; event.executionCompleted = true; }
  return event;
}

const GENERIC_CAPABILITIES: AdapterCapabilities = { host: "generic", hooks: [], promptContextInjection: false, sessionContextInjection: false,
  toolEvidence: false, taskBoundary: false, refresh: "none", limitations: ["Caller must supply normalized task events; no automatic host observation."] };
export function capabilitiesFor(host: HostId): AdapterCapabilities {
  return { "claude-code": CLAUDE_CODE_CAPABILITIES, codex: CODEX_CAPABILITIES, gemini: GEMINI_CAPABILITIES, cursor: CURSOR_CAPABILITIES, generic: GENERIC_CAPABILITIES }[host];
}
export function normalizeHook(host: HostId, value: unknown): NormalizedHook {
  switch (host) {
    case "claude-code": return normalizeClaudeCode(value);
    case "codex": return normalizeCodex(value);
    case "gemini": return normalizeGemini(value);
    case "cursor": return normalizeCursor(value);
    case "generic": {
      const input = inputRecord(value), event = baseHook(host, input);
      if (event.eventName === "task-start") return taskStart(event, input);
      if (event.eventName === "tool-result") return normalizedTool(event, input, input.tool_output ?? input.tool_response, input.status === "error");
      if (event.eventName === "task-end") { event.kind = "task-end"; event.assistantText = boundedText(input.assistant_text); event.terminal = "unknown"; event.executionCompleted = true; }
      return event;
    }
    default: throw new Error("Unsupported AutoSkill host.");
  }
}

/** Never ask a completion hook to continue a finished conversation. */
export function hookResponse(host: HostId, eventName: string, context?: string): Record<string, unknown> {
  if (!context?.trim()) return {};
  if (context.length > 9_000) throw new Error("Hook context exceeds the portable 9000-character budget.");
  if ((host === "claude-code" || host === "codex") && (eventName === "UserPromptSubmit" || eventName === "SubagentStart") || host === "gemini" && eventName === "BeforeAgent") {
    return { hookSpecificOutput: { hookEventName: eventName, additionalContext: context } };
  }
  if (host === "cursor" && eventName === "sessionStart") return { additional_context: context };
  if (host === "cursor" && (eventName === "postToolUse" || eventName === "postToolUseFailure")) return { additional_context: context };
  return {};
}
