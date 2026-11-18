import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeHook } from "../dist/adapters/events.js";
import { EventStore } from "../dist/portable/event-store.js";
import { readOptions } from "../dist/config.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-hook-capture-"));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), "{}\n");
  let store = new EventStore(root, readOptions());
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, async reopen() { await store.close(); store = new EventStore(root, readOptions()); } };
}

test("Claude event capture survives process restart and associates completed tools with prompt identity", async (t) => {
  const f = await fixture(t);
  const base = { session_id: "claude-session", prompt_id: "prompt-1", cwd: f.root, transcript_path: "/not-readable/transcript.jsonl" };
  const start = await f.store.accept(normalizeHook("claude-code", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Diagnose the compiler failure and verify its repair" }));
  assert.ok(start.task);
  await f.reopen();
  const toolBase = { ...base, tool_use_id: "tool-read", tool_name: "Read", tool_input: { file_path: path.join(f.root, "src", "main.ts") } };
  await f.store.accept(normalizeHook("claude-code", { ...toolBase, hook_event_name: "PreToolUse" }));
  const after = normalizeHook("claude-code", { ...toolBase, hook_event_name: "PostToolUse", tool_response: { type: "text", text: "The compiler is configured with the unsupported module mode" } });
  const observed = await f.store.accept(after);
  assert.equal(observed.task.id, start.task.id);
  assert.equal(observed.task.snapshot.messages.flatMap((message) => message.tools).length, 1);
  assert.equal(observed.task.snapshot.messages.flatMap((message) => message.tools)[0].status, "completed");
  assert.equal((await f.store.accept(after)).duplicate, true);
  const end = await f.store.accept(normalizeHook("claude-code", { ...base, hook_event_name: "Stop", last_assistant_message: "Updated the module configuration; the regression test passed." }));
  assert.equal(end.task.ended, true);
  assert.equal(end.task.snapshot.terminal, "unknown");
  assert.equal(end.task.snapshot.executionCompleted, true);
  assert.equal((await f.store.pending()).length, 1);
  assert.doesNotMatch(JSON.stringify(end.task), /not-readable/);
});

test("Codex running exec results stay pending until a later result proves process exit", async (t) => {
  const f = await fixture(t);
  const base = { session_id: "codex-thread", turn_id: "codex-turn", cwd: f.root, agent_id: "root-agent" };
  const start = await f.store.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Repair the build and run the regression suite" }));
  assert.ok(start.task, "a root agent_id alone must not suppress a user task");
  const tool = { ...base, tool_use_id: "exec-1", tool_name: "Bash", tool_input: { command: "npm test" } };
  await f.store.accept(normalizeHook("codex", { ...tool, hook_event_name: "PreToolUse" }));
  const running = await f.store.accept(normalizeHook("codex", { ...tool, hook_event_name: "PostToolUse", tool_response: { output: "Starting regression suite", session_id: 42 } }));
  const pending = running.task.snapshot.messages.flatMap((message) => message.tools);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.ok(running.task.coverage.includes("process_still_running"));
  const finished = await f.store.accept(normalizeHook("codex", { ...tool, hook_event_name: "PostToolUse", tool_response: { output: "19 regression checks passed", exit_code: 0 } }));
  const evidence = finished.task.snapshot.messages.flatMap((message) => message.tools);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].status, "completed");
  assert.equal(evidence[0].nativeCallId, "exec-1");
  assert.match(evidence[0].output, /19 regression checks passed/);
});

test("model-facing async exec text and nonzero exits retain their actual status", () => {
  const base = { session_id: "codex", turn_id: "turn", cwd: process.cwd(), hook_event_name: "PostToolUse", tool_use_id: "exec", tool_name: "exec_command", tool_input: { cmd: "npm test" } };
  const running = normalizeHook("codex", { ...base, tool_response: "Chunk ID: abc\nWall time: 1 seconds\nProcess running with session ID 444\nOutput:\nStarting" });
  assert.equal(running.tool.status, "pending");
  const failed = normalizeHook("codex", { ...base, tool_response: "Chunk ID: abc\nProcess exited with code 1\nFinal output:\nCompiler target is unsupported" });
  assert.equal(failed.tool.status, "error");
  const success = normalizeHook("codex", { ...base, tool_response: "Chunk ID: abc\nProcess exited with code 0\nFinal output:\nAll checks passed" });
  assert.equal(success.tool.status, "completed");
});

test("Cursor captures final response without transcripts and redacted tools never become successful evidence", async (t) => {
  const f = await fixture(t);
  const base = { conversation_id: "cursor-chat", generation_id: "generation-1", workspace_roots: [f.root], transcript_path: null };
  await f.store.accept(normalizeHook("cursor", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Inspect the remote validation result" }));
  await f.store.accept(normalizeHook("cursor", { ...base, hook_event_name: "postToolUse", tool_use_id: "remote-call", tool_name: "MCP:remote_check", tool_input: {}, tool_output: '{"redacted":true}' }));
  const response = await f.store.accept(normalizeHook("cursor", { ...base, hook_event_name: "afterAgentResponse", text: "The provider withheld the remote result." }));
  assert.equal(response.task.ended, false);
  const stop = await f.store.accept(normalizeHook("cursor", { ...base, hook_event_name: "stop", status: "completed" }));
  assert.equal(stop.task.ended, true);
  assert.equal(stop.task.snapshot.messages.flatMap((message) => message.tools)[0].status, "pending");
  assert.match(stop.task.snapshot.messages.find((message) => message.id === "assistant-final").text, /withheld/);
  assert.equal(stop.task.snapshot.terminal, "unknown");
  assert.ok(stop.task.coverage.includes("tool_output_redacted"));
});

test("Gemini missing native IDs remain disclosed and repeat user turns get distinct task identities", async (t) => {
  const f = await fixture(t);
  const base = { session_id: "gemini-session", cwd: f.root, transcript_path: "/not-read/session.json" };
  const first = await f.store.accept(normalizeHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "Inspect the module configuration" }));
  const result = await f.store.accept(normalizeHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "read_file", tool_input: { file_path: "tsconfig.json" }, tool_response: { llmContent: "Module target is CommonJS" } }));
  assert.equal(result.task.id, first.task.id);
  assert.ok(result.task.coverage.includes("missing_tool_call_id"));
  await f.store.accept(normalizeHook("gemini", { ...base, hook_event_name: "AfterAgent", prompt_response: "The project uses CommonJS." }));
  const second = await f.store.accept(normalizeHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "Inspect the module configuration" }));
  assert.notEqual(second.task.id, first.task.id);
  assert.equal(second.task.snapshot.messages.flatMap((message) => message.tools).length, 0);
});

test("explicit turn IDs prevent delayed results from moving to another task", async (t) => {
  const f = await fixture(t);
  const base = { session_id: "interleaved", cwd: f.root };
  const one = await f.store.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", turn_id: "one", prompt: "Inspect compiler configuration" }));
  const two = await f.store.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", turn_id: "two", prompt: "Inspect package scripts" }));
  const late = await f.store.accept(normalizeHook("codex", { ...base, hook_event_name: "PostToolUse", turn_id: "one", tool_use_id: "late", tool_name: "Read", tool_input: { file_path: "tsconfig.json" }, tool_response: "CommonJS" }));
  assert.equal(late.task.id, one.task.id);
  assert.equal((await f.store.get(two.task.id)).snapshot.messages.flatMap((message) => message.tools).length, 0);
});
