/** Isolated hook CLI -> durable worker -> shared skill -> MCP reuse smoke. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { installHost } from "../dist/portable/install.js";
import { QueueStore } from "../dist/jobs.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const entry = path.join(packageRoot, "bin/autoskill.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-portable-smoke-"));
let reviewerCalls = 0, mcp;
const query = "Diagnose invoice cache contamination caused by omitted tenant key dimensions and verify tenant isolation";
const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/complexity.json", import.meta.url), "utf8"));
const fixture = corpus.cases.find(item => item.id === "two-call-root-cause").snapshot;
const server = http.createServer(async (req, res) => {
  try {
    let body = ""; for await (const part of req) body += part;
    const request = JSON.parse(body); reviewerCalls++;
    assert.equal(req.url, "/v1/chat/completions");
    const evidence = JSON.parse(/<task-evidence>\s*([\s\S]*?)\s*<\/task-evidence>/.exec(request.messages[0].content)[1]);
    const tools = evidence.messages.flatMap(message => message.tools);
    const citations = [{ toolCallId: tools[0].id, excerpt: tools[0].output, supports: "procedure" }, { toolCallId: tools.at(-1).id, excerpt: tools.at(-1).output, supports: "verification" }];
    const assessmentCitations = citations.map(({ toolCallId, excerpt }) => ({ toolCallId, excerpt }));
    const decision = { action: "create", reason: "A verified tenant cache diagnosis can be reused.", taskCompleted: true, reusable: true, confidence: 0.96,
      skill: { id: "tenant-cache-diagnosis", name: "Tenant cache isolation diagnosis", description: query,
        whenToUse: ["Invoice cache records collide across tenants sharing an invoice ID."], prerequisites: [],
        steps: ["Reproduce the invoice cache collision using two tenant IDs sharing an invoice ID.", "Identify the omitted tenant dimension and independently verify tenant-aware cache key isolation."],
        pitfalls: ["An invoice ID alone is not a globally unique cache key."], verification: ["Run independent cross-tenant invoice cache isolation regressions."] }, evidence: citations,
      assessment: { complexity: { nontrivial: true, dimensions: [{ kind: "dependent-steps", rationale: "The observed collision determines the diagnosis, followed by an independent isolation regression.", evidence: assessmentCitations }] },
        value: { transferable: true, nonObvious: true, addsKnowledge: true, rationale: "The tenant-key dependency and its independent verification apply to equivalent cache isolation failures.", evidence: assessmentCitations } } };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
function hook(host, event, data) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "hook", "--host", host, "--event", event, "--project", root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AUTOSKILL_INTERNAL: "0" } });
    let output = "", errors = ""; child.stdout.on("data", part => output += part); child.stderr.on("data", part => errors += part);
    child.on("error", reject); child.on("close", code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ ...data, cwd: root }));
  });
}
function connectMcp() {
  const child = spawn(process.execPath, [entry, "serve", "--host", "codex", "--project", root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", errors = "", next = 0; const pending = new Map();
  child.stderr.on("data", part => errors += part);
  child.stdout.on("data", part => {
    buffer += part; let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message); }
    }
  });
  child.on("error", error => { for (const callback of pending.values()) callback({ error: { message: error.message } }); pending.clear(); });
  return { async call(method, params) {
    const id = ++next;
    const response = await Promise.race([new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }), delay(15_000, undefined, { ref: false }).then(() => { throw new Error(`MCP timeout: ${errors}`); })]);
    if (response.error) throw new Error(response.error.message); return response.result;
  }, async close() { if (child.exitCode !== null) return; child.stdin.end(); await new Promise(resolve => child.once("close", resolve)); } };
}
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const host of ["claude-code", "codex", "gemini", "cursor", "generic"]) await installHost({ root, host, packageDir: packageRoot });
  const configFile = path.join(root, ".autoskill/config.json"), config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.options = { cooldownMs: 0, debounceMs: 0, globalStateDirectory: path.join(root, ".private-global") };
  config.reviewer = { type: "openai-compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "local-smoke" };
  await fs.writeFile(configFile, JSON.stringify(config));
  const base = { session_id: "learn-session", prompt_id: "learn-task" };
  await hook("claude-code", "UserPromptSubmit", { ...base, prompt: fixture.messages[0].text });
  for (const tool of fixture.messages[1].tools) {
    const data = { ...base, tool_name: "Bash", tool_use_id: tool.id, tool_input: tool.input };
    await hook("claude-code", "PreToolUse", data);
    await hook("claude-code", "PostToolUse", { ...data, tool_response: { stdout: tool.output, exit_code: 0 } });
  }
  assert.deepEqual(await hook("claude-code", "Stop", { ...base, last_assistant_message: fixture.messages[1].text }), {});
  const queue = new QueueStore(root); let saved = false;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      const jobs = Object.values((await queue.read()).jobs);
      if (jobs.some(job => job.status === "saved")) { saved = true; break; }
      const failed = jobs.find(job => job.status === "failed"); if (failed) throw new Error(JSON.stringify(failed.result));
      await delay(200);
    }
  } finally { await queue.close(); }
  assert.ok(saved, "detached worker did not publish the skill"); assert.equal(reviewerCalls, 1);
  const reused = await hook("codex", "UserPromptSubmit", { session_id: "reuse-session", turn_id: "reuse-task", prompt: query });
  const context = reused.hookSpecificOutput.additionalContext;
  assert.match(context, /tenant-cache-diagnosis/);
  const contextToken = /contextToken: ([a-f0-9-]{36})/.exec(context)[1];
  mcp = connectMcp(); await mcp.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "portable-smoke", version: "1" } });
  const list = await mcp.call("tools/list"); assert.equal(list.tools.length, 5);
  const search = await mcp.call("tools/call", { name: "autoskill_search", arguments: { query, contextToken } }); assert.ok(!search.isError);
  const load = await mcp.call("tools/call", { name: "autoskill_load", arguments: { skillId: "tenant-cache-diagnosis", contextToken } }); assert.equal(load.structuredContent.status, "loaded");
  const feedback = await mcp.call("tools/call", { name: "autoskill_feedback", arguments: { skillId: "tenant-cache-diagnosis", contextToken, used: true, outcome: "success" } }); assert.equal(feedback.structuredContent.source, "model");
  console.log(JSON.stringify({ passed: true, scope: "isolated host-shaped hooks and real MCP/worker processes; local mock reviewer", hostsInstalled: 5, reviewerCalls, sharedSkill: "tenant-cache-diagnosis", crossPlatformReuse: "claude-code -> codex", nativeClientVerification: false }, null, 2));
} finally {
  if (mcp) await mcp.close(); await new Promise(resolve => server.close(resolve));
  // Worker sees the committed publication and exits at its next polling interval.
  await delay(500); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-portable-smoke-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
