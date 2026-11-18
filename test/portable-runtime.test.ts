import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { PortableRuntime, runRuntimeCommand } from "../dist/portable/runtime.js";
import { installHost } from "../dist/portable/install.js";
import { normalizeHook } from "../dist/adapters/events.js";
import { callMcpTool, serveMcp } from "../dist/mcp/server.js";
import { generateReview, reviewerStatus } from "../dist/portable/reviewer.js";
import { withAssessment } from "./helpers/assessment.ts";

const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/complexity.json", import.meta.url), "utf8"));
const evidenceFixture = corpus.cases.find((item: any) => item.id === "two-call-root-cause").snapshot;

async function fixture(t: test.TestContext, reviewer = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-runtime-"));
  await installHost({ root, host: "claude-code" }); await installHost({ root, host: "codex" }); await installHost({ root, host: "generic" });
  const file = path.join(root, ".autoskill/config.json"); const config = JSON.parse(await fs.readFile(file, "utf8"));
  config.options = { cooldownMs: 0, debounceMs: 0, globalStateDirectory: path.join(root, "global-private"), reuseAutoLoadScore: 0.3 };
  let calls = 0, response: any;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/v1/chat/completions"); const request = JSON.parse(body);
    assert.equal(request.model, "fixture-reviewer"); calls++;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  if (reviewer) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.reviewer = { type: "openai-compatible", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: "fixture-reviewer" };
  }
  await fs.writeFile(file, JSON.stringify(config));
  t.after(async () => { if (reviewer) await new Promise<void>((resolve) => server.close(() => resolve())); assert.ok(path.basename(root).startsWith("autoskill-runtime-")); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, get calls() { return calls; }, set response(value) { response = value; } };
}

async function capturedTask(runtime: PortableRuntime) {
  const base = { session_id: "same-native-session", prompt_id: "prompt-one", cwd: runtime.root };
  const start = await runtime.events.accept(normalizeHook("claude-code", { ...base, hook_event_name: "UserPromptSubmit", prompt: evidenceFixture.messages[0].text }));
  for (const tool of evidenceFixture.messages[1].tools) {
    const input = { ...base, tool_use_id: tool.id, tool_name: "Bash", tool_input: tool.input };
    await runtime.events.accept(normalizeHook("claude-code", { ...input, hook_event_name: "PreToolUse" }));
    await runtime.events.accept(normalizeHook("claude-code", { ...input, hook_event_name: "PostToolUse", tool_response: { stdout: tool.output, exit_code: 0 } }));
  }
  const end = await runtime.events.accept(normalizeHook("claude-code", { ...base, hook_event_name: "Stop", last_assistant_message: evidenceFixture.messages[1].text }));
  assert.equal(start.task!.id, end.task!.id); return end.task!;
}

test("trusted Claude evidence is reviewed once and reused with versioned model feedback by Codex after restart", async (t) => {
  const f = await fixture(t, true); const source = await PortableRuntime.open(f.root, "claude-code");
  const task = await capturedTask(source), tools = task.snapshot.messages.flatMap((message) => message.tools);
  f.response = withAssessment({ action: "create", reason: "A bounded tenant cache isolation diagnosis is transferable.", taskCompleted: true, reusable: true, confidence: 0.96,
    skill: { id: "tenant-cache-diagnosis", name: "Tenant cache isolation diagnosis", description: "Diagnose invoice cache contamination caused by omitted tenant key dimensions and verify tenant isolation.",
      whenToUse: ["Invoice cache records collide across tenants sharing an invoice ID."], prerequisites: [],
      steps: ["Reproduce the invoice cache collision using two tenant IDs sharing an invoice ID.", "Identify the omitted tenant dimension and independently verify tenant-aware cache key isolation."],
      pitfalls: ["An invoice ID alone is not a globally unique cache key."], verification: ["Run independent cross-tenant invoice cache isolation regressions."] },
    evidence: [{ toolCallId: tools[0]!.id, excerpt: tools[0]!.output, supports: "procedure" }, { toolCallId: tools.at(-1)!.id, excerpt: tools.at(-1)!.output, supports: "verification" }] });
  assert.equal((await source.review(task.contextToken) as any).status, "saved");
  await source.events.captured(task.id);
  assert.equal((await source.review(task.contextToken) as any).reasonCode, "already_reviewed");
  assert.equal(f.calls, 1); await source.close();
  let target = await PortableRuntime.open(f.root, "codex");
  const search: any = await callMcpTool(target, "autoskill_search", { query: "Diagnose invoice cache contamination caused by omitted tenant key dimensions and verify tenant isolation" });
  assert.ok(search.candidates.some((item: any) => item.id === "tenant-cache-diagnosis"));
  assert.equal(search.association, "explicit-mcp-query"); await target.close();
  target = await PortableRuntime.open(f.root, "codex");
  try {
    const loaded: any = await callMcpTool(target, "autoskill_load", { contextToken: search.contextToken, skillId: "tenant-cache-diagnosis" });
    assert.equal(loaded.status, "loaded"); assert.match(loaded.content, /tenant/i);
    const feedback: any = await callMcpTool(target, "autoskill_feedback", { contextToken: search.contextToken, skillId: "tenant-cache-diagnosis", used: true, outcome: "success" });
    assert.equal(feedback.source, "model");
    assert.equal((await callMcpTool(target, "autoskill_review", { contextToken: search.contextToken }) as any).reasonCode, "trusted_completed_evidence_required");
    const state: any = await target.status(); assert.equal(state.engine.reuse.history[0]?.userFeedback?.success ?? 0, 0);
    assert.equal(state.engine.reuse.history[0]?.modelFeedback?.success, 1);
    const files = await fs.readdir(path.join(f.root, ".autoskill/skills")); assert.deepEqual(files, ["tenant-cache-diagnosis"]);
  } finally { await target.close(); }
});

test("missing reviewer preserves durable evidence and cannot publish from model-authored input", async (t) => {
  const f = await fixture(t); const runtime = await PortableRuntime.open(f.root, "claude-code");
  try {
    const task = await capturedTask(runtime); assert.equal(await runtime.capturePending(), 1);
    assert.equal((await runtime.review(task.contextToken) as any).reasonCode, "model_backend_unconfigured");
    const status: any = await runtime.status(); assert.equal(status.reviewer.available, false);
    assert.ok(status.engine.jobs.some((job: any) => job.status === "pending"));
    await assert.rejects(callMcpTool(runtime, "autoskill_review", { contextToken: task.contextToken, evidence: "I ran tests" }), /Unknown argument/);
    await assert.rejects(callMcpTool(runtime, "autoskill_feedback", { contextToken: task.contextToken, skillId: "x", used: true, outcome: "success", source: "user" }), /Unknown argument/);
  } finally { await runtime.close(); }
});

test("superseded prompts reject their old context tokens and sensitive tasks store no tool outputs", async (t) => {
  const f = await fixture(t); const runtime = await PortableRuntime.open(f.root, "codex");
  try {
    const base = { session_id: "thread", turn_id: "turn", cwd: f.root, hook_event_name: "UserPromptSubmit" };
    const first = await runtime.events.accept(normalizeHook("codex", { ...base, prompt: "Investigate invoice cache collisions" }));
    await runtime.events.accept(normalizeHook("codex", { ...base, prompt: "Investigate a revised package build failure" }));
    await assert.rejects(runtime.resolveTask(first.task!.contextToken), /superseded/);
    const sensitive = await runtime.events.accept(normalizeHook("codex", { ...base, turn_id: "private", prompt: "api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890" }));
    assert.equal(sensitive.task!.sensitive, true);
    const result = await runtime.events.accept(normalizeHook("codex", { ...base, turn_id: "private", hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "secret", tool_input: {}, tool_response: "private output" }));
    assert.equal(result.reasonCode, "sensitive_task_excluded");
    assert.doesNotMatch(JSON.stringify(result.task), /private output|sk-abcdefghijklmnopqrstuvwxyz/);
  } finally { await runtime.close(); }
});

test("MCP wire protocol initializes, validates arguments and emits only JSON-RPC", async (t) => {
  const f = await fixture(t); const runtime = await PortableRuntime.open(f.root, "generic"); let wire = "";
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "autoskill_search", arguments: { query: "Inspect TypeScript configuration" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "autoskill_feedback", arguments: { source: "user" } } },
  ];
  try {
    await serveMcp(runtime, Readable.from(messages.map((item) => JSON.stringify(item) + "\n")), new Writable({ write(chunk, _encoding, callback) { wire += chunk; callback(); } }));
    const results = wire.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(results[0].error.code, -32002); assert.equal(results[1].result.protocolVersion, "2025-11-25");
    assert.equal(results[2].result.tools.length, 5); assert.equal(results[3].result.structuredContent.association, "explicit-mcp-query");
    assert.equal(results[4].result.isError, true);
  } finally { await runtime.close(); }
});

test("installed hook command runs through the packaged CLI and returns valid optional context", async (t) => {
  const f = await fixture(t);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("bin/autoskill.mjs"), "hook", "--host", "codex", "--event", "UserPromptSubmit", "--project", f.root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: "cli-thread", turn_id: "cli-turn", cwd: f.root, prompt: "Inspect the invoice cache contamination" }));
  });
  assert.equal(result.code, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit"); assert.match(output.hookSpecificOutput.additionalContext, /contextToken/);
});

test("reviewer rejects embedded credentials and missing explicit environment credentials", async () => {
  assert.equal(reviewerStatus().reasonCode, "model_backend_unconfigured");
  assert.throws(() => reviewerStatus({ type: "openai-compatible", baseUrl: "http://remote.example/v1", model: "x", apiKeyEnv: "NO_TEST_KEY" }), /HTTPS/);
  assert.throws(() => reviewerStatus({ type: "openai-compatible", baseUrl: "https://user:pass@example.test/v1", model: "x", apiKeyEnv: "NO_TEST_KEY" }), /credentials/);
  assert.equal(reviewerStatus({ type: "openai-compatible", baseUrl: "https://example.test/v1", model: "x", apiKeyEnv: "AUTOSKILL_TEST_MISSING_214782" }).reasonCode, "model_credential_missing");
  await assert.rejects(generateReview(undefined, { prompt: "x", signal: new AbortController().signal }), /model_backend_unconfigured/);
});
