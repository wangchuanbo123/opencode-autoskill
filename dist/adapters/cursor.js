import { baseHook, boundedText, inputRecord, normalizedTool, normalizedToolStart, subagentHook, taskStart, identifier } from "./events.js";
export const CURSOR_CAPABILITIES = {
    host: "cursor", hooks: ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "stop", "afterAgentResponse", "subagentStart", "subagentStop"],
    promptContextInjection: false, sessionContextInjection: true, toolEvidence: true, taskBoundary: true,
    nativeSkillDirectory: ".cursor/skills", refresh: "next-session",
    limitations: ["beforeSubmitPrompt cannot inject per-task context; use MCP search/load or a native skill.", "sessionStart context is unavailable on some cloud surfaces.", "Cloud HTTP MCP results may be redacted.", "No transcript is required or read."]
};
export function normalizeCursor(value) {
    const raw = inputRecord(value), roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
    const input = { ...raw, cwd: raw.cwd ?? (roots.length === 1 ? roots[0] : undefined) };
    const event = baseHook("cursor", input, raw.conversation_id ?? raw.session_id, raw.generation_id ?? raw.turn_id);
    event.agentId = identifier(raw.agent_id ?? raw.subagent_id);
    event.parentId = identifier(raw.parent_conversation_id ?? raw.parent_session_id ?? raw.parent_id);
    switch (event.eventName) {
        case "sessionStart":
            event.kind = "session-start";
            return event;
        case "beforeSubmitPrompt": return taskStart(event, input);
        case "preToolUse": return normalizedToolStart(event, input);
        case "postToolUse": return normalizedTool(event, input, input.tool_output ?? input.tool_result);
        case "postToolUseFailure": return normalizedTool(event, input, input.tool_output ?? input.error_message, true);
        case "afterAgentResponse":
            // This is a response notification, not the authoritative end of the generation.
            event.assistantText = boundedText(input.text ?? input.response ?? input.last_assistant_message);
            event.coverage.reasons.push("response_is_not_completion");
            return event;
        case "stop":
            event.kind = "task-end";
            event.terminal = input.status === "aborted" ? "interrupted" : input.status === "error" ? "failure" : "unknown";
            event.executionCompleted = input.status !== "aborted" && input.status !== "error";
            event.assistantText = boundedText(input.last_assistant_message ?? input.response);
            return event;
        case "subagentStart": return subagentHook(event);
        case "subagentStop":
            event.assistantText = boundedText(input.last_assistant_message ?? input.summary);
            return subagentHook(event, true);
        default:
            event.coverage.reasons.push("unsupported_event");
            return event;
    }
}
//# sourceMappingURL=cursor.js.map