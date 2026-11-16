import { baseHook, boundedText, inputRecord, normalizedTool, normalizedToolStart, taskStart } from "./events.js";
import type { AdapterCapabilities, NormalizedHook } from "./events.js";

export const GEMINI_CAPABILITIES: AdapterCapabilities = {
  host: "gemini", hooks: ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
  promptContextInjection: true, sessionContextInjection: false, toolEvidence: true, taskBoundary: true,
  nativeSkillDirectory: ".agents/skills", refresh: "reload-command",
  limitations: ["Base hook schema does not guarantee a turn or tool-call ID.", "SessionEnd is best effort and is not a reliable completion boundary.", "Native skill activation and resource access retain Gemini consent requirements."]
};

export function normalizeGemini(value: unknown): NormalizedHook {
  const input = inputRecord(value), event = baseHook("gemini", input);
  switch (event.eventName) {
    case "SessionStart": event.kind = "session-start"; return event;
    case "BeforeAgent": return taskStart(event, input);
    case "BeforeTool": return normalizedToolStart(event, input);
    case "AfterTool": return normalizedTool(event, input, input.tool_response);
    case "AfterAgent": event.kind = "task-end"; event.terminal = "unknown"; event.executionCompleted = true; event.assistantText = boundedText(input.prompt_response); return event;
    default: event.coverage.reasons.push("unsupported_event"); return event;
  }
}
