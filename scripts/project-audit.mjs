// Read-only product audit: reproduction projects are isolated in the OS temp directory.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PortableRuntime, runRuntimeCommand } from "../dist/portable/runtime.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-product-audit-"));
const configFile = path.join(root, ".autoskill", "config.json");
const results = {};
let lock;
async function configure(enabled) {
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 1,
    adapters: { codex: { enabled: true } }, options: { enabled, globalStateDirectory: path.join(root, "global-private") }, agentPolicy: "root-only" }));
}
async function hook(event, extra = {}) {
  return runRuntimeCommand({ command: "hook", root, host: "codex", event,
    input: { cwd: root, session_id: "disabled-session", turn_id: "disabled-turn", ...extra } });
}
async function runHookChild(session) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("bin/autoskill.mjs"), "hook", "--host", "codex", "--event", "UserPromptSubmit", "--project", root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", part => stdout += part);
    child.stderr.on("data", part => stderr += part);
    child.on("error", reject);
    child.on("close", code => resolve({ elapsedMs: Math.round(performance.now() - start), code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(JSON.stringify({ cwd: root, session_id: session, turn_id: session, prompt: "Inspect package build configuration" }));
  });
}
try {
  await configure(false);
  await hook("UserPromptSubmit", { prompt: "Inspect internal project build settings" });
  await hook("PostToolUse", { tool_use_id: "read-config", tool_name: "Read", tool_input: { file_path: "package.json" }, tool_response: "Internal project build setting audit-marker-913" });
  const runtime = await PortableRuntime.open(root, "codex");
  try {
    const task = await runtime.events.current("codex", "disabled-session");
    const status = await runtime.status();
    results.disabledCapture = { fixed: !task, enabled: status.engine.enabled, storedTask: !!task, storedPrompt: task?.prompt,
      storedToolOutputs: task?.snapshot.messages.flatMap(message => message.tools.map(tool => tool.output)) };
    assert.equal(task, undefined, "Disabled hooks must not retain task evidence");
    assert.equal(status.summary.phase, "disabled");
  } finally { await runtime.close(); }

  await configure(true);
  results.uncontendedHook = await runHookChild("baseline-session");
  lock = new DatabaseSync(path.join(root, ".autoskill", "runtime", "runtime.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  results.contendedHook = await runHookChild("contended-session");
  assert.equal(results.contendedHook.code, 0);
  assert.deepEqual(JSON.parse(results.contendedHook.stdout), {});
  assert.ok(results.contendedHook.elapsedMs < 4_500, "Hook lock waits exceeded the shared deadline plus startup allowance");
  results.hookDeadlineFixed = true;
  lock.exec("ROLLBACK"); lock.close(); lock = undefined;
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
} finally {
  if (lock) { lock.exec("ROLLBACK"); lock.close(); }
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("autoskill-product-audit-")) throw new Error("Unexpected audit fixture path");
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
