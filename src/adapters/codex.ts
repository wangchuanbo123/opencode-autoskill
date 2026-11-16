import { baseHook, boundedText, inputRecord, normalizedTool, normalizedToolStart, subagentHook, taskStart } from "./events.js";
import type { AdapterCapabilities, NormalizedHook } from "./events.js";

export const CODEX_CAPABILITIES: AdapterCapabilities = {
  host: "codex", hooks: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SubagentStart", "SubagentStop"],
  promptContextInjection: true, sessionContextInjection: false, toolEvidence: true, taskBoundary: true,
  nativeSkillDirectory: ".agents/skills", refresh: "next-session",
  limitations: ["Hook availability depends on the installed Codex release.", "Unsupported and remote tool paths may be absent from hooks.", "Stop denotes execution end, not verified task success."]
};

export function normalizeCodex(value: unknown): NormalizedHook {
  const input = inputRecord(value), event = baseHook("codex", input);
  switch (event.eventName) {
    case "SessionStart": event.kind = "session-start"; return event;
    case "UserPromptSubmit": return taskStart(event, input);
    case "PreToolUse": return normalizedToolStart(event, input);
    case "PostToolUse": return normalizedTool(event, input, input.tool_response);
    case "Stop": event.kind = "task-end"; event.terminal = "unknown"; event.executionCompleted = true; event.assistantText = boundedText(input.last_assistant_message); return event;
    case "Interrupt": event.kind = "task-end"; event.terminal = "interrupted"; event.executionCompleted = false; return event;
    case "SubagentStart": return subagentHook(event);
    case "SubagentStop": event.assistantText = boundedText(input.last_assistant_message); return subagentHook(event, true);
    default: event.coverage.reasons.push("unsupported_event"); return event;
  }
}
