import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { serveMcp } from "../dist/mcp/server.js";
import { PortableRuntime } from "../dist/portable/runtime.js";
import { installHost } from "../dist/portable/install.js";
import { normalizeHook } from "../dist/adapters/events.js";
import { cleanEvidence } from "../dist/maintenance.js";

test("MCP preserves Chinese queries when UTF-8 characters span stdio chunks", async () => {
  const query = "数据库迁移锁重试";
  const protocol = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "autoskill_search", arguments: { query } } }) + "\n", "utf8");
  const split = protocol.indexOf(Buffer.from("数", "utf8")) + 1;
  const seen = [];
  const runtime = { async search(value) { seen.push(value); return { query: value }; } };
  let text = "";
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString("utf8"); callback(); } });
  await serveMcp(runtime, Readable.from([protocol.subarray(0, split), protocol.subarray(split)]), output);
  assert.deepEqual(seen, [query]);
  const result = text.trim().split("\n").map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.equal(result.result.structuredContent.query, query);
});

test("evidence cleanup preserves captured portable tasks while reviewer jobs are pending", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-clean-pending-"));
  let runtime;
  try {
    await installHost({ root, host: "claude-code" });
    const configFile = path.join(root, ".autoskill/config.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    config.options = { cooldownMs: 0, debounceMs: 0, globalStateDirectory: path.join(root, "global-private") };
    await fs.writeFile(configFile, JSON.stringify(config));
    runtime = await PortableRuntime.open(root, "claude-code");
    const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/complexity.json", import.meta.url), "utf8"));
    const evidence = corpus.cases.find(item => item.id === "two-call-root-cause").snapshot;
    const base = { session_id: "cleanup-session", prompt_id: "cleanup-prompt", cwd: root };
    await runtime.events.accept(normalizeHook("claude-code", { ...base, hook_event_name: "UserPromptSubmit", prompt: evidence.messages[0].text }));
    for (const tool of evidence.messages[1].tools) {
      const call = { ...base, tool_use_id: tool.id, tool_name: "Bash", tool_input: tool.input };
      await runtime.events.accept(normalizeHook("claude-code", { ...call, hook_event_name: "PreToolUse" }));
      await runtime.events.accept(normalizeHook("claude-code", { ...call, hook_event_name: "PostToolUse", tool_response: { stdout: tool.output, exit_code: 0 } }));
    }
    const completed = await runtime.events.accept(normalizeHook("claude-code", { ...base, hook_event_name: "Stop", last_assistant_message: evidence.messages[1].text }));
    assert.equal(await runtime.capturePending(), 1);
    assert.equal((await runtime.events.get(completed.task.id)).captured, true);
    const before = await runtime.status();
    assert.ok(before.engine.jobs.some(job => job.status === "pending"));
    await delay(10);
    const cleaned = await cleanEvidence(root, { olderThanDays: 0 });
    assert.equal(cleaned.eventTasks ?? 0, 0);
    assert.ok(await runtime.events.get(completed.task.id), "pending reviewer must retain authoritative task evidence for re-screening");
  } finally {
    await runtime?.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
