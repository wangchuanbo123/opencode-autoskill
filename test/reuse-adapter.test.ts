import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { detectCapabilities, detectReuseCapabilities, filterManagedSkillCatalog, setupAdapter } from "../dist/index.js";
import { digest } from "../dist/tasks.js";

const nativeCatalog = `<available_skills>
  <skill><id>managed-id</id><name>shared-title</name><description>PRIVATE_MANAGED_CATALOG</description></skill>
  <skill><id>user-id</id><name>shared-title</name><description>EXTERNAL_USER_SKILL</description></skill>
</available_skills>`;

function harness(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, (input: any) => Promise<void>>();
  const tools: any[] = [];
  const prepared: any[] = [];
  const requestedContexts: any[] = [];
  const loads: any[] = [];
  const searches: any[] = [];
  const feedback: any[] = [];
  const disposed: string[] = [];
  let info: any = { id: "session", location: { directory: process.cwd() }, agent: "build", time: { created: 1 } };
  const ctx: any = {
    app: { version: "2.2.7" }, location: { directory: process.cwd() }, options,
    session: {
      get: async () => structuredClone(info), context: async () => [],
      hook: async (name: string, callback: (input: any) => Promise<void>) => { hooks.set(name, callback); return { dispose() { disposed.push(name); } }; },
      synthetic: () => assert.fail("reuse must not create synthetic user messages"),
    },
    tool: { transform: async (callback: (editor: any) => void) => { callback({ add: (tool: any) => tools.push(tool) }); return { dispose() { disposed.push("tools"); } }; } },
    experimental: { generate: { text: async () => ({ text: "unused" }) } },
    skill: { list: async () => ({ data: [] }), reload: async () => {} },
    event: { subscribe: () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }) },
  };
  const engine: any = {
    schedule() {}, review: async () => ({ status: "skipped" }), status: async () => ({}), dispose() { disposed.push("engine"); },
    prepareReuse: async (input: any) => { prepared.push(input); },
    reuseContext: async (...args: any[]) => { requestedContexts.push(args); return { text: "BOUNDED_REUSE_CONTEXT", candidateIds: ["managed-id"], catalog: [{ id: "managed-id", description: "managed" }] }; },
    loadReuse: async (input: any) => { loads.push(input); return { status: "loaded" }; },
    searchReuse: async (input: any) => { searches.push(input); return { candidates: [{ id: "managed-id", description: "bounded summary" }] }; },
    reuseFeedback: async (input: any) => { feedback.push(input); return { status: "reported" }; },
  };
  const prompt = (messageID = "user-first") => ({ sessionID: "session", messageID, delivery: "steer", prompt: { text: "Investigate the cache issue", skills: [{ id: "user-id" }] } });
  const context = (messageId = "user-first") => ({ sessionID: "session", agent: "build", model: { providerID: "local", id: "model" },
    system: [{ type: "text", text: `PRESERVED_SYSTEM\n${nativeCatalog}` }],
    messages: [{ id: messageId, role: "user", content: [{ type: "text", text: "Current user task" }] }, { id: "assistant", role: "assistant", content: [] }],
    options: {}, tools: { skill: { description: `PRESERVED_TOOL_DESCRIPTION\n${nativeCatalog}`, input: { type: "object", properties: { id: { type: "string" } } } },
      shell: { description: "unrelated tool", input: {} } } });
  return { ctx, engine, hooks, tools, prepared, requestedContexts, loads, searches, feedback, disposed, prompt, context, setInfo(value: any) { info = value; } };
}

test("reuse capability checks are independent of the background review provider API", () => {
  const { ctx } = harness();
  assert.equal(detectReuseCapabilities(ctx).supported, true);
  delete ctx.experimental.generate.text;
  assert.equal(detectCapabilities(ctx).supported, false);
  assert.equal(detectReuseCapabilities(ctx).supported, true);
  delete ctx.session.hook;
  assert.deepEqual(detectReuseCapabilities(ctx).missing, ["session.hook"]);
  ctx.app.version = "2.3.0";
  assert.ok(detectReuseCapabilities(ctx).missing.some((name: string) => name.startsWith("host.version:")));
});

test("prompt admission searches each user message without rewriting text or explicit skill attachments", async () => {
  const f = harness();
  let port: any;
  const cleanup = await setupAdapter(f.ctx, (value: any) => { port = value; return f.engine; });
  try {
    assert.equal(port.reuseCapabilities.supported, true);
    assert.deepEqual([...f.hooks.keys()], ["prompt", "context"]);
    const input = f.prompt(); const before = structuredClone(input);
    await f.hooks.get("prompt")!(input);
    await f.hooks.get("prompt")!(f.prompt("user-second"));
    assert.deepEqual(input, before);
    assert.deepEqual(f.prepared.map(({ sessionId, messageId, text }) => ({ sessionId, messageId, text })),
      ["user-first", "user-second"].map((messageId) => ({ sessionId: "session", messageId, text: input.prompt.text })));
    assert.ok(f.prepared.every((item: any) => item.signal instanceof AbortSignal));
  } finally { await cleanup(); }
});

test("context is tied to its actual user message and replaces its own block while retaining external skills", async () => {
  const f = harness();
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    await f.hooks.get("prompt")!(f.prompt("queued-new-user"));
    const input = f.context("running-old-user");
    const schema = structuredClone(input.tools.skill.input);
    await f.hooks.get("context")!(input);
    await f.hooks.get("context")!(input);
    assert.deepEqual(f.requestedContexts.map((args: any[]) => [args[0], args[2]]), [["session", "running-old-user"], ["session", "running-old-user"]]);
    assert.ok(f.requestedContexts.every((args: any[]) => args[3] === digest("Current user task")));
    assert.equal(input.system.filter((part: any) => part.metadata?.autoskillReuse).length, 1);
    assert.equal(input.system.at(-1)!.text, "BOUNDED_REUSE_CONTEXT");
    assert.match(input.system[0]!.text, /PRESERVED_SYSTEM|EXTERNAL_USER_SKILL/);
    assert.doesNotMatch(input.system[0]!.text, /PRIVATE_MANAGED_CATALOG/);
    assert.match(input.tools.skill.description, /EXTERNAL_USER_SKILL/);
    assert.doesNotMatch(input.tools.skill.description, /PRIVATE_MANAGED_CATALOG/);
    assert.deepEqual(input.tools.skill.input, schema);
    assert.equal(input.tools.shell.description, "unrelated tool");
    assert.deepEqual(f.loads, []);
  } finally { await cleanup(); }
});

test("native catalog filtering is exact-ID and conservatively preserves unknown formats", () => {
  const filtered = filterManagedSkillCatalog(nativeCatalog, new Set(["managed-id"]));
  assert.doesNotMatch(filtered, /PRIVATE_MANAGED_CATALOG/);
  assert.match(filtered, /EXTERNAL_USER_SKILL/);
  assert.match(filtered, /shared-title/);
  for (const value of ["No catalog", "<available_skills><skill><name>managed-id</name></skill></available_skills>",
    "<available_skills><skill><id>managed-id</id><name>name</name><unknown>future</unknown></skill></available_skills>",
    "<available_skills>future-format</available_skills>"]) assert.equal(filterManagedSkillCatalog(value, new Set(["managed-id"])), value);
  const alias = "<available_skills><skill><name>name</name><id>host-id</id><description>actual native alias</description></skill></available_skills>";
  assert.doesNotMatch(filterManagedSkillCatalog(alias, new Set(["host-id"])), /actual native alias/);
});

test("same user message ID passes the actual context revision hash rather than the latest admission text", async () => {
  const f = harness();
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    const queued = f.prompt("same-user-id"); queued.prompt.text = "A newer queued revision";
    await f.hooks.get("prompt")!(queued);
    const current = f.context("same-user-id");
    await f.hooks.get("context")!(current);
    current.messages[0]!.content[0]!.text = queued.prompt.text;
    await f.hooks.get("context")!(current);
    assert.equal(f.requestedContexts[0][3], digest("Current user task"));
    assert.equal(f.requestedContexts[1][3], digest("A newer queued revision"));
    assert.notEqual(f.requestedContexts[0][3], f.requestedContexts[1][3]);
  } finally { await cleanup(); }
});

test("rendered text attachments do not change the admitted user task revision", async () => {
  const f = harness();
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    const input = f.context();
    input.messages[0]!.content.push({ type: "text", text: "\n\nAttached file: context.txt\n\nAdditional project context." });
    await f.hooks.get("context")!(input);
    assert.equal(f.requestedContexts[0][3], digest("Current user task"));
    assert.notEqual(f.requestedContexts[0][3], digest(input.messages[0]!.content.map((part: any) => part.text).join("\n")));
  } finally { await cleanup(); }
});

test("excluded, child, reviewer and other-directory sessions cannot prepare or inject reusable skills", async () => {
  const f = harness({ excludeSessions: ["private-*"] });
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    const excluded = f.prompt(); excluded.sessionID = "private-session";
    await f.hooks.get("prompt")!(excluded);
    for (const info of [
      { parentID: "parent", location: { directory: process.cwd() }, agent: "build" },
      { location: { directory: process.cwd() }, agent: "autoskill-reviewer" },
      { location: { directory: os.tmpdir() }, agent: "build" },
    ]) {
      f.setInfo(info); await f.hooks.get("prompt")!(f.prompt());
      const input = f.context(); await f.hooks.get("context")!(input);
      assert.equal(input.system.length, 1);
    }
    assert.equal(f.prepared.length, 0); assert.equal(f.requestedContexts.length, 0);
  } finally { await cleanup(); }
});

test("disabled reuse and missing hooks preserve distillation tools and skip reuse registration", async () => {
  for (const options of [{ reuseEnabled: false }, { enabled: false }, {}]) {
    const f = harness(options);
    if (!Object.keys(options).length) delete f.ctx.session.hook;
    const cleanup = await setupAdapter(f.ctx, () => f.engine);
    assert.deepEqual(f.tools.map((tool: any) => tool.name), ["autoskill_status", "autoskill_review"]);
    assert.equal(f.hooks.size, 0);
    await cleanup();
  }
});

test("reuse tools recheck session scope after an admitted task moves directory or becomes a child", async () => {
  const f = harness();
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    await f.hooks.get("prompt")!(f.prompt());
    await f.hooks.get("context")!(f.context());
    const toolContext = { sessionID: "session", signal: new AbortController().signal };
    for (const info of [
      { id: "session", location: { directory: os.tmpdir() }, agent: "build" },
      { id: "session", parentID: "parent", location: { directory: process.cwd() }, agent: "build" },
    ]) {
      f.setInfo(info);
      for (const [name, input] of [
        ["autoskill_search", { query: "specific tenant isolation" }],
        ["autoskill_load", { skillId: "managed-id" }],
        ["autoskill_feedback", { skillId: "managed-id", used: true, outcome: "success" }],
      ] as const) {
        const result = JSON.parse((await f.tools.find((tool: any) => tool.name === name).execute(input, toolContext)).content);
        assert.deepEqual(result, { status: "unavailable", reasonCode: "session_out_of_scope" });
      }
    }
    assert.deepEqual(f.searches, []); assert.deepEqual(f.loads, []); assert.deepEqual(f.feedback, []);
  } finally { await cleanup(); }
});

test("reuse tool calls forward cancellation and distinguish reported use from loaded status", async () => {
  const f = harness();
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    const load = f.tools.find((tool: any) => tool.name === "autoskill_load");
    const feedback = f.tools.find((tool: any) => tool.name === "autoskill_feedback");
    const search = f.tools.find((tool: any) => tool.name === "autoskill_search");
    const context = { sessionID: "session", signal: new AbortController().signal };
    assert.equal(JSON.parse((await search.execute({ query: "specific tenant isolation" }, context)).content).candidates.length, 1);
    assert.equal(f.searches[0].query, "specific tenant isolation");
    assert.equal(f.loads.length, 0);
    await assert.rejects(search.execute({ query: " " }, context), /query/);
    await assert.rejects(search.execute({ query: "a".repeat(1501) }, context), /query/);
    assert.equal(JSON.parse((await load.execute({ skillId: "managed-id" }, context)).content).status, "loaded");
    assert.equal(f.feedback.length, 0);
    await feedback.execute({ skillId: "managed-id", used: false, outcome: "unknown" }, context);
    assert.equal(f.feedback[0].used, false); assert.equal(f.feedback[0].outcome, "unknown");
    assert.ok(f.loads[0].signal instanceof AbortSignal);
    assert.equal(load.options.codemode, false); assert.equal(feedback.options.codemode, false);
    assert.equal(search.options.codemode, false);
    await assert.rejects(feedback.execute({ skillId: "managed-id", outcome: "success" }, context), /used/);
    await assert.rejects(load.execute({ skillId: "managed-id" }, { ...context, signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.equal(f.loads.length, 1);
  } finally { await cleanup(); }
});

test("a reuse deadline aborts uncooperative indexing and leaves the primary request unchanged", async () => {
  const f = harness({ reuseTimeoutMs: 100 });
  let signal: AbortSignal | undefined;
  f.engine.prepareReuse = async (input: any) => { signal = input.signal; await new Promise(() => {}); };
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  try {
    const input = f.prompt(); const before = structuredClone(input);
    const start = Date.now(); await f.hooks.get("prompt")!(input);
    assert.ok(Date.now() - start < 1_000); assert.equal(signal!.aborted, true);
    assert.deepEqual(input, before);
  } finally { await cleanup(); }
});

test("cleanup cancels pending reuse hooks and disposes each registration once", async () => {
  const f = harness();
  let entered = false; let signal: AbortSignal | undefined;
  f.engine.prepareReuse = async (input: any) => { entered = true; signal = input.signal; await new Promise(() => {}); };
  const cleanup = await setupAdapter(f.ctx, () => f.engine);
  const pending = f.hooks.get("prompt")!(f.prompt());
  while (!entered) await delay(5);
  await cleanup(); await pending; await cleanup();
  assert.equal(signal!.aborted, true);
  assert.deepEqual(f.disposed.sort(), ["context", "engine", "prompt", "tools"]);
});

test("a failed context hook registration rolls back the prompt hook, tools and engine", async () => {
  const f = harness();
  const register = f.ctx.session.hook;
  f.ctx.session.hook = async (name: string, callback: any) => { if (name === "context") throw new Error("context registration failed"); return register(name, callback); };
  await assert.rejects(setupAdapter(f.ctx, () => f.engine), /context registration failed/);
  assert.deepEqual(f.disposed.sort(), ["engine", "prompt", "tools"]);
});
