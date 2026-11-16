import { baseHook, boundedText, inputRecord, normalizedTool, normalizedToolStart, subagentHook, taskStart } from "./events.js";
export const CLAUDE_CODE_CAPABILITIES = {
    host: "claude-code", hooks: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop"],
    promptContextInjection: true, sessionContextInjection: false, toolEvidence: true, taskBoundary: true,
    nativeSkillDirectory: ".claude/skills", refresh: "watch",
    limitations: ["Transcript writes may lag hooks; transcripts are not read.", "Stop denotes execution end, not verified task success.", "Subagent events are observed but are not independently published."]
};
export function normalizeClaudeCode(value) {
    const input = inputRecord(value), event = baseHook("claude-code", input);
    switch (event.eventName) {
        case "SessionStart":
            event.kind = "session-start";
            return event;
        case "UserPromptSubmit": return taskStart(event, input);
        case "PreToolUse": return normalizedToolStart(event, input);
        case "PostToolUse": return normalizedTool(event, input, input.tool_response);
        case "PostToolUseFailure": return normalizedTool(event, input, input.tool_response ?? input.error, true);
        case "Stop":
            event.kind = "task-end";
            event.terminal = "unknown";
            event.executionCompleted = true;
            event.assistantText = boundedText(input.last_assistant_message);
            return event;
        case "SubagentStart": return subagentHook(event);
        case "SubagentStop":
            event.assistantText = boundedText(input.last_assistant_message);
            return subagentHook(event, true);
        default:
            event.coverage.reasons.push("unsupported_event");
            return event;
    }
}
//# sourceMappingURL=claude-code.js.map