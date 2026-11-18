import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { PortableRuntime, runRuntimeCommand } from "../dist/portable/runtime.js";
import { EventStore } from "../dist/portable/event-store.js";
import { normalizeHook } from "../dist/adapters/events.js";
import { readOptions } from "../dist/config.js";

async function fixture(t, enabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-runtime-fix-"));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), JSON.stringify({ schemaVersion: 1,
    adapters: { codex: { enabled: true } }, options: { enabled, globalStateDirectory: path.join(root, "global-private") }, agentPolicy: "root-only" }));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-runtime-fix-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}

function childHook(root, event, { endInput = true } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>((resolve, reject) => {
    // Import costs vary with the number of parallel test processes. Measure the
    // real dispatcher after module loading; isolated CLI wall time is recorded
    // separately by scripts/project-audit.mjs.
    const dispatcher = pathToFileURL(path.resolve("bin/autoskill.mjs")).href;
    const portable = pathToFileURL(path.resolve("bin/portable-cli.mjs")).href;
    const runtime = pathToFileURL(path.resolve("dist/portable/runtime.js")).href;
    const source = `import { runCli } from ${JSON.stringify(dispatcher)};
      import ${JSON.stringify(portable)}; import ${JSON.stringify(runtime)};
      const started = performance.now();
      try { process.exitCode = await runCli(process.argv.slice(1)); }
      catch { process.stdout.write('{}\\n'); process.exitCode = 0; }
      finally { process.stderr.write('HOOK_TEST_ELAPSED=' + (performance.now() - started) + '\\n'); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, "hook", "--host", "codex", "--event", event, "--project", root],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const watchdog = setTimeout(() => { child.kill(); reject(new Error("Hook exceeded the external test watchdog.")); }, 12_000);
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", error => { clearTimeout(watchdog); reject(error); });
    child.on("close", code => {
      clearTimeout(watchdog);
      const elapsed = /HOOK_TEST_ELAPSED=([\d.]+)/.exec(stderr);
      if (!elapsed) { reject(new Error(`Hook did not report completion: ${stderr}`)); return; }
      resolve({ code, stdout, stderr, elapsedMs: Number(elapsed[1]) });
    });
    if (endInput) child.stdin.end(JSON.stringify({ cwd: root, session_id: "deadline-session", turn_id: "deadline-turn", prompt: "Investigate the build configuration" }));
    child.stdin.on("error", () => {});
  });
}

test("disabled hooks skip initialization and SDK reuse cannot retain queries", async t => {
  const root = await fixture(t, false);
  const base = { cwd: root, session_id: "disabled", turn_id: "turn" };
  const result = await runRuntimeCommand({ command: "hook", root, host: "codex", event: "UserPromptSubmit", input: { ...base, prompt: "Private project task" } });
  assert.deepEqual(result, {});
  await assert.rejects(fs.access(path.join(root, ".autoskill", "runtime")), { code: "ENOENT" });
  const runtime = await PortableRuntime.open(root, "codex");
  try {
    assert.equal((await runtime.search("Private supplemental query") as any).status, "disabled");
    assert.equal((await runtime.load("skill", "unused") as any).status, "disabled");
    assert.equal((await runtime.review("unused") as any).status, "disabled");
    assert.equal(await runtime.capturePending(), 0);
    const ignored = await runtime.events.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Private project task" }));
    assert.equal(ignored.reasonCode, "disabled");
    await assert.rejects(fs.access(path.join(root, ".autoskill", "runtime", "events.sqlite")), { code: "ENOENT" });
  } finally { await runtime.close(); }
});

test("one hook deadline covers queue initialization lock waits and cleanup", async t => {
  const root = await fixture(t);
  const runtime = await PortableRuntime.open(root, "codex");
  await runtime.status(); await runtime.close();
  const db = new DatabaseSync(path.join(root, ".autoskill", "runtime", "runtime.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await childHook(root, "UserPromptSubmit");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.ok(result.elapsedMs < 4_500, `Hook took ${result.elapsedMs}ms, beyond the shared deadline plus startup allowance.`);
  } finally { db.exec("ROLLBACK"); db.close(); }
  // The accepted boundary remains available for a later task-end/retry.
  const store = new EventStore(root, readOptions());
  try { assert.ok(await store.current("codex", "deadline-session")); } finally { await store.close(); }
});

test("the hook deadline also bounds a locked event database", async t => {
  const root = await fixture(t);
  const store = new EventStore(root, readOptions()); await store.status(); await store.close();
  const db = new DatabaseSync(path.join(root, ".autoskill", "runtime", "events.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await childHook(root, "UserPromptSubmit");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.ok(result.elapsedMs < 4_500, `Event lock held the hook for ${result.elapsedMs}ms.`);
  } finally { db.exec("ROLLBACK"); db.close(); }
});

test("a hook with an unfinished stdin stream exits at its deadline", async t => {
  const root = await fixture(t);
  const result = await childHook(root, "UserPromptSubmit", { endInput: false });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.ok(result.elapsedMs < 4_500, `Incomplete stdin held the hook for ${result.elapsedMs}ms.`);
});
