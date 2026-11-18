import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { PortableRuntime } from "../dist/portable/runtime.js";
import { EventStore } from "../dist/portable/event-store.js";
import { QueueStore } from "../dist/jobs.js";
import { readOptions } from "../dist/config.js";
import { normalizeHook } from "../dist/adapters/events.js";

const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/complexity.json", import.meta.url), "utf8"));
const evidence = corpus.cases.find(item => item.id === "two-call-root-cause").snapshot;
const skipDecision = { action: "skip", reason: "The isolated reviewer deliberately declines publication.", taskCompleted: true, reusable: false, confidence: 0.99, evidence: [] };

async function until(predicate, message, timeoutMs = 15_000) {
  const untilAt = Date.now() + timeoutMs;
  while (Date.now() < untilAt) { if (await predicate()) return; await delay(50); }
  throw new Error(message);
}

async function fixture(t, transientFirst = false) {
  const tempBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempBase, "autoskill-worker-recovery-"));
  const requests = [], workerPids = new Set(), children = new Set();
  let queue;
  const server = http.createServer(async (req, res) => {
    try {
      for await (const chunk of req) {} // The configured loopback reviewer receives no external credentials.
      requests.push(Date.now());
      for (const job of Object.values((await queue.read()).jobs)) if (job.status === "running" && job.lease?.pid) workerPids.add(job.lease.pid);
      if (transientFirst && requests.length === 1) { res.statusCode = 503; res.end("temporary local failure"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(skipDecision) } }] }));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill/config.json"), JSON.stringify({ schemaVersion: 1, adapters: { codex: { enabled: true } }, agentPolicy: "root-only",
    options: { cooldownMs: 0, debounceMs: 0, retryBaseMs: 3_500, maxAttempts: 2, globalStateDirectory: path.join(root, "private-global") },
    reviewer: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "isolated-reviewer" } }));
  queue = new QueueStore(root);
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    for (const pid of workerPids) if (pid !== process.pid) { try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue.close();
    assert.equal(path.dirname(root), tempBase); assert.ok(path.basename(root).startsWith("autoskill-worker-recovery-"));
    assert.equal(await fs.realpath(root), root); assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function command(commandName, event?, input?) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("bin/autoskill.mjs"), commandName, "--host", "codex", "--project", root, ...(event ? ["--event", event] : [])],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child); let stdout = "", stderr = "";
      const watchdog = setTimeout(() => { child.kill(); reject(new Error(`${commandName} exceeded the 15 second recovery watchdog.`)); }, 15_000);
      child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", error => { clearTimeout(watchdog); reject(error); });
      child.on("close", code => { clearTimeout(watchdog); children.delete(child); resolve({ code, stdout, stderr }); });
      child.stdin.on("error", () => {}); child.stdin.end(input ? JSON.stringify(input) : "");
    });
  }
  return { root, requests, queue, command };
}

async function prepareEvidence(root, completed = false) {
  const runtime = await PortableRuntime.open(root, "codex"), base = { session_id: "worker-session", turn_id: "worker-turn", cwd: root };
  try {
    await runtime.status();
    const start = await runtime.events.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: evidence.messages[0].text }));
    for (const tool of evidence.messages[1].tools) await runtime.events.accept(normalizeHook("codex", { ...base, hook_event_name: "PostToolUse", tool_use_id: tool.id, tool_name: "Bash", tool_input: tool.input, tool_response: { stdout: tool.output, exit_code: 0 } }));
    if (completed) {
      await runtime.events.accept(normalizeHook("codex", { ...base, hook_event_name: "Stop", last_assistant_message: evidence.messages[1].text }));
      assert.equal(await runtime.capturePending(), 1);
    }
    return { base, taskId: start.task.id };
  } finally { await runtime.close(); }
}

test("a timed-out Stop still starts a worker that captures evidence after its queue lock is released", async t => {
  const f = await fixture(t), prepared = await prepareEvidence(f.root);
  const db = new DatabaseSync(path.join(f.root, ".autoskill/runtime/runtime.sqlite")); db.exec("BEGIN IMMEDIATE");
  let result;
  try { result = await f.command("hook", "Stop", { ...prepared.base, last_assistant_message: evidence.messages[1].text }); }
  finally { db.exec("ROLLBACK"); db.close(); }
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), {});
  await until(async () => f.requests.length === 1 && Object.values((await f.queue.read()).jobs).some(job => job.status === "skipped" && job.attempts === 1), "The Stop recovery worker never processed its durable task evidence.");
  const events = new EventStore(f.root, readOptions());
  try { assert.equal((await events.get(prepared.taskId)).captured, true); } finally { await events.close(); }
});

test("a standalone worker retries a transient reviewer failure after the old three second cutoff", async t => {
  const f = await fixture(t, true); await prepareEvidence(f.root, true);
  const result = await f.command("worker");
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, "idle");
  assert.equal(f.requests.length, 2, "No MCP server or new hook exists to trigger the second attempt.");
  assert.ok(f.requests[1] - f.requests[0] >= 3_300, "The real retry must wait for its configured backoff.");
  const jobs = Object.values((await f.queue.read()).jobs);
  assert.ok(jobs.some(job => job.status === "skipped" && job.attempts === 2));
  assert.ok(jobs.every(job => !["pending", "retry", "running"].includes(job.status)));
});
