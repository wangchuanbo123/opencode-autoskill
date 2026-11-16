import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs/promises";
import plugin, { detectCapabilities, normalizeSnapshot, setupAdapter } from "../dist/index.js";

function session(overrides = {}) {
  return {
    id: "ses_example", location: { directory: process.cwd() }, projectID: "project_example",
    model: { providerID: "provider", id: "model" }, agent: "build",
    outcome: "succeeded", time: { created: 1, updated: 90, busy: 10, idle: 90 },
    ...overrides,
  };
}

function assistant(content, overrides = {}) {
  return {
    id: "msg_assistant", type: "assistant", agent: "build", model: { providerID: "provider", id: "model" },
    time: { created: 20, completed: 80 }, content, finish: "stop", ...overrides,
  };
}

function tool(id, state, extra = {}) {
  return { id, type: "tool", name: "shell", time: { created: 25, completed: 70 }, state, ...extra };
}

test("V2 normalization keeps executable evidence and excludes hidden or unrelated context", () => {
  const snapshot = normalizeSnapshot(session(), [
    { id: "msg_user", type: "user", time: { created: 5 }, text: "Fix the build", files: [{ data: "attachment-secret" }] },
    { id: "msg_system", type: "system", time: { created: 5 }, text: "system-secret" },
    { id: "msg_synthetic", type: "synthetic", time: { created: 5 }, text: "synthetic-secret" },
    { id: "msg_skill", type: "skill", time: { created: 5 }, text: "skill-secret" },
    assistant([
      { type: "reasoning", text: "reasoning-secret", native: { key: "native-secret" } },
      { type: "text", text: "Fixed and verified." },
      tool("call_ok", { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "12 tests passed" }, { type: "file", uri: "file-secret", mime: "text/plain" }] }),
      tool("call_error", { status: "error", input: { command: "npm test" }, error: { message: "compiler error", type: "shell" }, content: [{ type: "text", text: "failed compilation" }] }),
      tool("call_pending", { status: "running", input: { command: "npm test" }, metadata: { private: "metadata-secret" } }),
      tool("call_local", { status: "completed", input: {}, content: [{ type: "text", text: "locally executed result" }] }, { executed: false }),
    ]),
  ], "success");
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[1].text, "Fixed and verified.");
  assert.deepEqual(snapshot.messages[1].tools.map((item) => item.status), ["completed", "error", "pending", "completed"]);
  assert.equal(snapshot.messages[1].tools[0].output, "12 tests passed");
  assert.equal(snapshot.messages[1].tools[1].output, "failed compilation\ncompiler error");
  assert.equal(snapshot.messages[1].tools[3].output, "locally executed result");
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
  assert.equal(snapshot.directory, process.cwd());
  assert.deepEqual(snapshot.model, { providerID: "provider", id: "model" });
  assert.equal(snapshot.messages[0].createdAt, 5);
  assert.equal(snapshot.messages[1].createdAt, 20);
  assert.equal(snapshot.messages[1].completedAt, 80);
});

test("manual review selects the last completed boundary and preserves shell exit status", () => {
  const snapshot = normalizeSnapshot(session({ time: { created: 1, updated: 120, busy: 100, idle: 90 } }), [
    { id: "msg_user", type: "user", time: { created: 5 }, text: "Fix the build" },
    { id: "msg_shell", type: "shell", time: { created: 30, completed: 80 }, shellID: "sh_test", command: "npm test", status: "exited", exit: 0, output: { output: "passed", cursor: 6, size: 6, truncated: false } },
    { id: "msg_background", type: "shell", time: { created: 40, completed: 110 }, shellID: "sh_background", command: "background", status: "exited", exit: 0, output: { output: "future-secret" } },
    { id: "msg_current", type: "user", time: { created: 100 }, text: "current-secret" },
    assistant([{ type: "text", text: "current-secret" }], { id: "msg_current_assistant", time: { created: 110 } }),
  ], "idle");
  assert.equal(snapshot.terminal, "success");
  assert.equal(snapshot.messages[1].tools[0].id, "sh_test");
  assert.equal(snapshot.messages[1].tools[0].status, "completed");
  assert.equal(snapshot.messages[1].tools[0].output, "Exit code: 0\npassed");
  assert.equal(snapshot.messages[2].tools[0].status, "pending");
  assert.equal(snapshot.messages[1].completedAt, 80);
  assert.equal(snapshot.messages[2].completedAt, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});

test("persisted outcome overrides delayed success and incomplete sessions cannot be reviewed", () => {
  assert.equal(normalizeSnapshot(session({ outcome: "failed", parentID: "ses_parent" }), [], "success").terminal, "failure");
  assert.equal(normalizeSnapshot(session({ outcome: "interrupted" }), [], "success").terminal, "interrupted");
  assert.equal(normalizeSnapshot(session({ parentID: "ses_parent" }), [], "idle").parentId, "ses_parent");
  assert.throws(() => normalizeSnapshot(session({ outcome: undefined }), [], "idle"), /no completed execution/);
  assert.throws(() => normalizeSnapshot(session({ time: { created: 1, updated: 2 } }), [], "success"), /no completed execution/);
});

test("adapter subscribes to terminal events and uses stateless generation with cancellation", async () => {
  const tools = [];
  const scheduled = [];
  const reviews = [];
  const generated = [];
  let capturedPort;
  let subscription;
  let disposed = 0;
  let registrationsDisposed = 0;
  const engine = {
    schedule: (...args) => scheduled.push(args),
    review: async (...args) => { reviews.push(args); return { status: "skipped", reason: "test" }; },
    status: async () => ({ enabled: true }),
    dispose: async () => { disposed++; },
  };
  const ctx = {
    app: { version: "2.2.7" },
    location: { directory: process.cwd() }, options: { minToolCalls: 8 },
    session: {
      get: async () => session(), context: async () => [],
      generate: () => { throw new Error("session generation must never be used"); },
      synthetic: () => { throw new Error("must not inject session messages"); },
    },
    experimental: { generate: { text: async (...args) => { generated.push(args); return { text: "review-json" }; } } },
    skill: {
      list: async () => ({ location: { directory: process.cwd() }, data: [{ id: "skill_existing", name: "existing", path: "/existing/SKILL.md", content: "procedure", description: "Existing skill" }] }),
      reload: async () => {},
    },
    tool: { transform: async (transform) => { transform({ add: (item) => tools.push(item) }); return { dispose: async () => { registrationsDisposed++; } }; } },
    event: { async *subscribe(options) {
      subscription = options;
      for (const type of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]) {
        yield { type, data: { sessionID: "ses_example" } };
      }
    } },
  };
  const cleanup = await setupAdapter(ctx, (port) => { capturedPort = port; return engine; });
  await setImmediate();
  assert.deepEqual(scheduled, [["ses_example", "success"], ["ses_example", "failure"], ["ses_example", "interrupted"], ["ses_example", "idle"]]);
  assert.deepEqual(subscription.types, ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]);
  assert.deepEqual(tools.map((item) => item.name), ["autoskill_status", "autoskill_review"]);
  assert.equal(capturedPort.root, process.cwd());
  assert.deepEqual(capturedPort.capabilities, { supported: true, missing: [], hostVersion: "2.2.7" });
  assert.deepEqual(capturedPort.options, { minToolCalls: 8 });
  const signal = new AbortController().signal;
  assert.equal(await capturedPort.generate({ sessionId: "ses_example", model: { providerID: "provider", id: "model" }, prompt: "sanitized-prompt", signal }), "review-json");
  assert.deepEqual(generated[0][0], { model: { providerID: "provider", id: "model" }, prompt: "sanitized-prompt" });
  assert.equal(generated[0][1].signal.aborted, false);
  assert.deepEqual((await capturedPort.listSkills())[0], { id: "skill_existing", name: "existing", description: "Existing skill", path: "/existing/SKILL.md", content: "procedure", managed: false });
  assert.equal((await capturedPort.snapshot("ses_example", "idle")).terminal, "success");
  assert.deepEqual(JSON.parse((await tools[0].execute({}, { sessionID: "ses_example", signal })).content), { enabled: true });
  await tools[1].execute({ force: true, dryRun: true }, { sessionID: "ses_example", signal });
  await tools[1].execute({ force: "true" }, { sessionID: "ses_example", signal });
  assert.deepEqual(reviews.map(([sessionID, force, _signal, dryRun]) => [sessionID, force, dryRun]), [["ses_example", true, true], ["ses_example", false, false]]);
  assert.ok(reviews.every(([, , usedSignal]) => usedSignal instanceof AbortSignal));
  assert.ok(tools.every((tool) => tool.options.codemode === false));
  await assert.rejects(tools[1].execute({}, { sessionID: "ses_example", signal: AbortSignal.abort() }), { name: "AbortError" });
  await cleanup();
  await cleanup();
  assert.equal(subscription.signal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(registrationsDisposed, 1);
});

function harness(overrides = {}) {
  const tools = [];
  const ctx = {
    app: { version: "2.2.7" }, location: { directory: process.cwd() }, options: {},
    session: { get: async () => session(), context: async () => [] },
    experimental: { generate: { text: async () => ({ text: "decision" }) } },
    skill: { list: async () => ({ data: [] }), reload: async () => {} },
    tool: { transform: async (transform) => { transform({ add: (tool) => tools.push(tool) }); return { dispose() {} }; } },
    event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }) },
    ...overrides,
  };
  const engine = { schedule() {}, review: async () => ({}), status: async () => ({}), dispose() {} };
  return { ctx, tools, engine };
}

test("capability checks enforce the tested API range and expose missing methods", async () => {
  const { ctx, engine, tools } = harness();
  assert.equal(detectCapabilities(ctx).supported, true);
  for (const version of ["2.2.8", "v2.2.7", "2.2.7+build"]) {
    assert.equal(detectCapabilities({ ...ctx, app: { version } }).supported, true);
  }
  for (const version of [undefined, "dev", "2.2.6", "2.3.0", "3.0.0", "2.2.7-beta.1"]) {
    assert.equal(detectCapabilities({ ...ctx, app: { version } }).supported, false);
  }
  let subscribed = false;
  let port;
  ctx.experimental = {};
  ctx.event.subscribe = () => { subscribed = true; throw new Error("unsupported host must not subscribe"); };
  const cleanup = await setupAdapter(ctx, (value) => { port = value; return engine; });
  assert.deepEqual(port.capabilities.missing, ["experimental.generate.text"]);
  assert.equal(subscribed, false);
  assert.ok(tools.some((tool) => tool.name === "autoskill_status"));
  await cleanup();
});

test("host requests forward abort signals and bounded methods cancel even when the host ignores them", async () => {
  const captured = [];
  const { ctx, engine } = harness({
    session: {
      get: async (_input, options) => { captured.push(options.signal); return new Promise(() => {}); },
      context: async (_input, options) => { captured.push(options.signal); return new Promise(() => {}); },
    },
    skill: {
      list: async (_input, options) => { captured.push(options.signal); return new Promise(() => {}); },
      reload: async () => new Promise(() => {}),
    },
    experimental: { generate: { text: async (_input, options) => { captured.push(options.signal); return new Promise(() => {}); } } },
  });
  let port;
  const cleanup = await setupAdapter(ctx, (value) => { port = value; return engine; });
  const controller = new AbortController();
  const requests = [port.snapshot("ses_example", "idle", controller.signal), port.listSkills(controller.signal), port.reloadSkills(controller.signal), port.generate({ sessionId: "ses_example", prompt: "safe", signal: controller.signal })];
  assert.equal(captured.length, 4);
  controller.abort();
  await Promise.all(requests.map((request) => assert.rejects(request, { name: "AbortError" })));
  assert.ok(captured.every((signal) => signal.aborted));
  const pending = port.reloadSkills();
  await cleanup();
  await assert.rejects(pending, { name: "AbortError" });
});

test("manual tool cancellation reaches a review already in progress", async () => {
  const { ctx, engine, tools } = harness();
  let observedSignal;
  engine.review = async (_id, _force, signal) => {
    observedSignal = signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return { status: "cancelled" };
  };
  const cleanup = await setupAdapter(ctx, () => engine);
  const controller = new AbortController();
  const request = tools.find((tool) => tool.name === "autoskill_review").execute({}, { sessionID: "ses_example", signal: controller.signal });
  controller.abort();
  assert.equal(JSON.parse((await request).content).status, "cancelled");
  assert.equal(observedSignal.aborted, true);
  await cleanup();
});

test("event streams reconnect after failures and EOF with backoff, then cleanup stops retries", async () => {
  const attempts = [];
  const scheduled = [];
  const { ctx, engine } = harness({ event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
    attempts.push(Date.now());
    if (attempts.length === 1) throw new Error("disconnect");
    if (attempts.length === 2) return;
    yield { type: "session.execution.succeeded", data: { sessionID: "ses_reconnected" } };
    await new Promise(() => {});
  } }) } });
  engine.schedule = (...args) => scheduled.push(args);
  const cleanup = await setupAdapter(ctx, () => engine);
  const deadline = Date.now() + 3_000;
  while (scheduled.length === 0 && Date.now() < deadline) await delay(50);
  assert.deepEqual(scheduled, [["ses_reconnected", "success"]]);
  assert.ok(attempts[1] - attempts[0] >= 200);
  assert.ok(attempts[2] - attempts[1] >= 450);
  await Promise.race([cleanup(), delay(1_000).then(() => { throw new Error("cleanup hung on an uncooperative stream"); })]);
  const count = attempts.length;
  await delay(300);
  assert.equal(attempts.length, count);
});

test("the plugin entry point has no runtime SDK dependency", async () => {
  assert.equal(plugin.id, "opencode-autoskill");
  assert.equal(plugin.setup, setupAdapter);
  const emitted = await fs.readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(emitted, /(?:from|import\()\s*["']@opencode\/plugin/);
});

test("failed tool registration disposes the engine", async () => {
  let disposed = false;
  const ctx = {
    location: { directory: process.cwd() }, options: {},
    tool: { transform: async () => { throw new Error("registration failed"); } },
  };
  await assert.rejects(setupAdapter(ctx, () => ({ dispose: async () => { disposed = true; } })), /registration failed/);
  assert.equal(disposed, true);
});
