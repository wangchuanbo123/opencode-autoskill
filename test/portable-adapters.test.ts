import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHook, hookResponse, capabilitiesFor, boundedValue } from "../dist/adapters/events.js";

const base = { session_id: "session-1", cwd: process.cwd(), transcript_path: "/private/not-read.jsonl" };

test("Claude hooks retain prompt identity and observed tool evidence without reading transcripts", () => {
  const start = normalizeHook("claude-code", { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "prompt-1", prompt: "Repair the compiler failure" });
  assert.equal(start.kind, "task-start");
  assert.equal(start.turnId, "prompt-1");
  assert.equal(start.messageId, "prompt-1");
  assert.equal(start.prompt, "Repair the compiler failure");
  const tool = normalizeHook("claude-code", { ...base, hook_event_name: "PostToolUse", prompt_id: "prompt-1", tool_use_id: "call-1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "42 tests passed", stderr: "", exit_code: 0 } });
  assert.equal(tool.kind, "tool-result");
  assert.equal(tool.tool.name, "Bash");
  assert.equal(tool.tool.nativeName, "Bash");
  assert.equal(tool.tool.nativeCallId, "call-1");
  assert.equal(tool.tool.category, "execute");
  assert.equal(tool.tool.status, "completed");
  assert.equal(tool.tool.output, "Exit code: 0\n42 tests passed\n");
  assert.equal(tool.coverage.tools, "observed");
  assert.equal(tool.coverage.transcript, "not-read");
  assert.doesNotMatch(JSON.stringify(tool), /not-read\.jsonl/);
});

test("Stop is an execution boundary and never an inferred task success", () => {
  for (const host of ["claude-code", "codex"]) {
    const stop = normalizeHook(host, { ...base, hook_event_name: "Stop", turn_id: "turn-1", last_assistant_message: "Done", stop_hook_active: true });
    assert.equal(stop.kind, "task-end");
    assert.equal(stop.executionCompleted, true);
    assert.equal(stop.terminal, "unknown");
    assert.equal(stop.assistantText, "Done");
    assert.deepEqual(hookResponse(host, "Stop", "continue please"), {});
  }
});

test("tool failures and shell nonzero exits remain failures rather than successful evidence", () => {
  const claude = normalizeHook("claude-code", { ...base, hook_event_name: "PostToolUseFailure", tool_use_id: "failed", tool_name: "Edit", tool_input: { file_path: "main.ts" }, error: "Target text not found" });
  assert.equal(claude.tool.status, "error");
  assert.match(claude.tool.output, /Target text not found/);
  const codex = normalizeHook("codex", { ...base, hook_event_name: "PostToolUse", turn_id: "turn-1", tool_use_id: "failed", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { output: "1 test failed", exit_code: 1 } });
  assert.equal(codex.tool.status, "error");
  assert.match(codex.tool.output, /1 test failed/);
  const interrupted = normalizeHook("codex", { ...base, hook_event_name: "Interrupt", turn_id: "turn-1" });
  assert.equal(interrupted.terminal, "interrupted");
  assert.equal(interrupted.executionCompleted, false);
});

test("identical native call IDs cannot collide across hosts, turns or sessions", () => {
  const input = { ...base, hook_event_name: "PostToolUse", turn_id: "turn-1", tool_use_id: "same-call", tool_name: "Read", tool_input: { file_path: "main.ts" }, tool_response: "source text" };
  const first = normalizeHook("claude-code", input).tool.id;
  assert.equal(first, normalizeHook("claude-code", input).tool.id);
  assert.notEqual(first, normalizeHook("codex", input).tool.id);
  assert.notEqual(first, normalizeHook("claude-code", { ...input, turn_id: "turn-2" }).tool.id);
  assert.notEqual(first, normalizeHook("claude-code", { ...input, session_id: "session-2" }).tool.id);
});

test("Gemini accepts absent turn IDs but declares missing tool identity coverage", () => {
  const start = normalizeHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "Fix regression", timestamp: "2026-11-16T09:00:00Z" });
  assert.equal(start.kind, "task-start");
  assert.equal(start.turnId, undefined);
  const input = { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "npm test" }, tool_response: { llmContent: [{ text: "All tests passed" }] } };
  const one = normalizeHook("gemini", input), two = normalizeHook("gemini", input);
  assert.equal(one.tool.name, "run_shell_command");
  assert.equal(one.tool.output, "All tests passed");
  assert.equal(one.coverage.tools, "partial");
  assert.ok(one.coverage.reasons.includes("missing_tool_call_id"));
  assert.notEqual(one.tool.id, two.tool.id);
  const end = normalizeHook("gemini", { ...base, hook_event_name: "AfterAgent", prompt: "Fix regression", prompt_response: "Tests passed" });
  assert.equal(end.terminal, "unknown");
  assert.equal(end.assistantText, "Tests passed");
  assert.equal(normalizeHook("gemini", { ...base, hook_event_name: "SessionEnd" }).kind, "ignored");
});

test("Cursor works with disabled transcripts and refuses ambiguous multiroot cwd", () => {
  const cursorBase = { conversation_id: "chat-1", generation_id: "gen-1", workspace_roots: [process.cwd()], transcript_path: null };
  const start = normalizeHook("cursor", { ...cursorBase, hook_event_name: "beforeSubmitPrompt", prompt: "Repair the build" });
  assert.equal(start.cwd, process.cwd());
  assert.equal(start.sessionId, "chat-1");
  assert.equal(start.turnId, "gen-1");
  const tool = normalizeHook("cursor", { ...cursorBase, hook_event_name: "postToolUse", tool_use_id: "c1", tool_name: "Shell", tool_input: { command: "npm test" }, tool_output: JSON.stringify({ exitCode: 0, stdout: "passed" }) });
  assert.equal(tool.tool.status, "completed");
  assert.equal(tool.tool.output, "Exit code: 0\npassed");
  assert.throws(() => normalizeHook("cursor", { ...cursorBase, hook_event_name: "sessionStart", workspace_roots: ["/one", "/two"] }), /working directory/);
});

test("Cursor failures, redacted cloud outputs and response-only notifications retain limits", () => {
  const input = { ...base, conversation_id: "chat-1", generation_id: "gen-1" };
  const failed = normalizeHook("cursor", { ...input, hook_event_name: "postToolUseFailure", tool_use_id: "bad", tool_name: "Shell", error_message: "Command timed out", failure_type: "timeout" });
  assert.equal(failed.tool.status, "error");
  const redacted = normalizeHook("cursor", { ...input, hook_event_name: "postToolUse", tool_use_id: "remote", tool_name: "MCP:remote", tool_output: '{"redacted":true}' });
  assert.equal(redacted.tool.status, "pending");
  assert.equal(redacted.coverage.tools, "partial");
  assert.ok(redacted.coverage.reasons.includes("tool_output_redacted"));
  const response = normalizeHook("cursor", { ...input, hook_event_name: "afterAgentResponse", text: "Completed" });
  assert.equal(response.kind, "ignored");
  assert.equal(response.executionCompleted, undefined);
  for (const [status, terminal] of [["completed", "unknown"], ["aborted", "interrupted"], ["error", "failure"]]) assert.equal(normalizeHook("cursor", { ...input, hook_event_name: "stop", status }).terminal, terminal);
});

test("context responses follow each host's documented injection surface", () => {
  for (const host of ["claude-code", "codex"]) assert.deepEqual(hookResponse(host, "UserPromptSubmit", "reference"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "reference" } });
  assert.deepEqual(hookResponse("gemini", "BeforeAgent", "reference"), { hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "reference" } });
  assert.deepEqual(hookResponse("cursor", "beforeSubmitPrompt", "reference"), {});
  assert.deepEqual(hookResponse("cursor", "sessionStart", "reference"), { additional_context: "reference" });
  assert.deepEqual(hookResponse("cursor", "postToolUse", "reference"), { additional_context: "reference" });
  assert.deepEqual(hookResponse("cursor", "postToolUseFailure", "reference"), { additional_context: "reference" });
  assert.deepEqual(hookResponse("cursor", "subagentStart", "reference"), {});
  for (const host of ["claude-code", "codex"]) assert.deepEqual(hookResponse(host, "SubagentStart", "reference"), { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "reference" } });
  assert.deepEqual(hookResponse("generic", "task-start", "reference"), {});
  assert.throws(() => hookResponse("codex", "UserPromptSubmit", "x".repeat(9_001)), /budget/);
  assert.equal(capabilitiesFor("cursor").promptContextInjection, false);
  assert.equal(capabilitiesFor("codex").toolEvidence, true);
});

test("pending tool observations retain native identity until independent result arrives", () => {
  const input = { ...base, turn_id: "turn-1", tool_use_id: "pending-call", tool_name: "exec_command", tool_input: { cmd: "npm test" }, event_id: "event-1" };
  const before = normalizeHook("codex", { ...input, hook_event_name: "PreToolUse" });
  assert.equal(before.kind, "tool-start");
  assert.equal(before.tool.status, "pending");
  assert.equal(before.tool.nativeCallId, "pending-call");
  assert.equal(before.tool.sourceEventId, "event-1");
  assert.equal(before.tool.category, "execute");
  assert.equal(before.tool.output, "");
  const after = normalizeHook("codex", { ...input, event_id: "event-2", hook_event_name: "PostToolUse", tool_response: { output: "Passed", exit_code: 0 } });
  assert.equal(before.tool.id, after.tool.id);
  assert.equal(after.tool.status, "completed");
  assert.equal(after.tool.sourceEventId, "event-2");
});

test("internal prompts and subagent events cannot masquerade as new human tasks", () => {
  assert.equal(normalizeHook("claude-code", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Review report", source: "subagent-report" }).kind, "ignored");
  assert.equal(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Continue", source: "scheduled" }).kind, "ignored");
  const child = normalizeHook("claude-code", { ...base, hook_event_name: "SubagentStop", agent_id: "child-1", parent_session_id: "parent-1", last_assistant_message: "Report" });
  assert.equal(child.kind, "subagent-end");
  assert.equal(child.origin, "subagent");
  assert.equal(child.agentId, "child-1");
  assert.equal(child.parentId, "parent-1");
});

test("unknown events, invalid identities and hidden media data are bounded safely", () => {
  assert.equal(normalizeHook("claude-code", { ...base, hook_event_name: "SomeFutureHook" }).kind, "ignored");
  assert.throws(() => normalizeHook("codex", []), /JSON object/);
  assert.throws(() => normalizeHook("codex", { ...base, hook_event_name: "Stop", session_id: "x".repeat(513) }), /identifier/);
  const circular = { text: "x".repeat(1_000_000), reasoning: "private", base64: "image" };
  circular.self = circular;
  const normalized = boundedValue(circular);
  assert.doesNotMatch(JSON.stringify(normalized), /private|image/);
  assert.ok(JSON.stringify(normalized).length < 65_000);
  const tool = normalizeHook("codex", { ...base, hook_event_name: "PostToolUse", tool_use_id: "safe", tool_name: "mcp__fs__read", tool_response: { content: [{ type: "text", text: "visible" }, { type: "image", data: "image-secret" }, { type: "reasoning", text: "hidden-secret" }] } });
  assert.equal(tool.tool.name, "mcp__fs__read");
  assert.equal(tool.tool.output, "visible");
});
