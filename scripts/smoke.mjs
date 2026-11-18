#!/usr/bin/env node
// Real OpenCode server + loopback mock model. No host configuration or credentials are inherited.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { QueueStore } from "../dist/jobs.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-autoskill-smoke-"));
const project = path.join(temporary, "project");
const home = path.join(temporary, "home");
const configDirectory = path.join(home, ".config", "opencode");
await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(configDirectory, { recursive: true }), fs.mkdir(path.join(temporary, "tmp"))]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(name)));
Object.assign(environment, {
  HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
  OPENCODE_CONFIG_DIR: configDirectory, TMPDIR: path.join(temporary, "tmp"), TMP: path.join(temporary, "tmp"), TEMP: path.join(temporary, "tmp"),
  OPENCODE_SERVER_PASSWORD: "autoskill-local-smoke",
});
let executable = process.env.OPENCODE_BIN ?? "opencode";
if (process.platform === "win32" && !process.env.OPENCODE_BIN) {
  const npmExecutable = path.join(process.env.APPDATA ?? "", "npm", "opencode.exe");
  if (await fs.stat(npmExecutable).then(() => true, () => false)) executable = npmExecutable;
}
let child;
let output = "";
let reviewRequests = 0;
let primaryRequests = 0;
let firstReviewHeld = false;
let spawnError;
let hostPhase = "initial-startup";
const hostOutput = [];
let childClosed = true;
let waitForClose;
const observedTools = new Set();

function startServer(port) {
  output = ""; spawnError = undefined;
  const processChild = child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { phase: hostPhase, output: "" }; hostOutput.push(record);
  childClosed = false;
  waitForClose = new Promise(resolve => processChild.once("close", () => { if (child === processChild) childClosed = true; resolve(); }));
  const append = data => { record.output = (record.output + data).slice(-20_000); if (child === processChild) output = record.output; };
  processChild.stdout.on("data", append);
  processChild.stderr.on("data", append);
  processChild.on("error", (error) => { if (child === processChild) spawnError = error; });
}

async function stopServer() {
  if (!child || childClosed) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([waitForClose, delay(5_000)]);
  if (!childClosed) throw new Error("The isolated OpenCode process or its output streams did not close.");
}

async function until(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function isolatedHostLogs() {
  const logs = [];
  // Read only the synthetic host's generated home; never inspect the user's host logs.
  async function visit(directory, depth = 0) {
    if (depth > 5 || logs.length >= 8) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (logs.length >= 8) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && /\.log$/i.test(entry.name)) {
        const handle = await fs.open(file, "r");
        try {
          const stat = await handle.stat(), size = Math.min(stat.size, 12_000), data = Buffer.alloc(size);
          await handle.read(data, 0, size, Math.max(0, stat.size - size));
          logs.push({ file: path.relative(home, file), tail: data.toString("utf8") });
        } finally { await handle.close(); }
      }
    }
  }
  await visit(home);
  return logs;
}

async function hostDiagnostics() {
  const diagnostics = JSON.stringify({ phase: hostPhase, pid: child?.pid, primaryRequests, reviewRequests,
    hosts: hostOutput, isolatedLogs: await isolatedHostLogs().catch(() => [{ unavailable: true }]) });
  return diagnostics.replace(/server password [^\\\r\n]+/g, "server password [redacted]").replaceAll(environment.OPENCODE_SERVER_PASSWORD, "[redacted]");
}

function response(res, body, content, toolCall) {
  const id = `chatcmpl_smoke_${Date.now()}`;
  const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input ?? {}) } }] } : { role: "assistant", content };
  const finishReason = toolCall ? "tool_calls" : "stop";
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [part, finish] of [[delta, null], [{}, finishReason]]) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "model", choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "model", choices: [{ index: 0, message: toolCall ? { role: "assistant", content: null, tool_calls: [delta.tool_calls[0]] } : { role: "assistant", content }, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
  }
}

const mock = http.createServer(async (req, res) => {
  try {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString());
    const serialized = JSON.stringify(body.messages ?? []);
    const evidenceMatch = /<task-evidence>\s*([\s\S]*?)\s*<\/task-evidence>/.exec((body.messages ?? []).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"));
    if (evidenceMatch) {
      reviewRequests++;
      assert.equal(body.tools?.length ?? 0, 0, "background review must have no tools");
      assert.ok(!serialized.includes(project), "review must redact the project path");
      const evidence = JSON.parse(evidenceMatch[1]);
      const tools = evidence.messages.flatMap((message) => message.tools);
      const prepare = tools.find((tool) => tool.name === "smoke_diagnose");
      const verify = tools.find((tool) => tool.name === "smoke_verify");
      const code = tools.find((tool) => tool.name === "execute");
      assert.ok(prepare && verify, "review needs both actual tool results");
      assert.match(code?.output ?? "", /Code Mode verification passed/, "review must retain the actual Code Mode result");
      // Simulate a process crash during a live provider request. Recovery must not need a new session event.
      if (reviewRequests === 1) { firstReviewHeld = true; return; }
      response(res, body, JSON.stringify({
        action: "create", reason: "Observed a completed reusable smoke workflow with independent verification.",
        taskCompleted: true, reusable: true, confidence: 0.99,
        assessment: {
          complexity: { nontrivial: true, dimensions: [{ kind: "tradeoff-decision", rationale: "The observed legacy schema conflicts with its separate contract, so migration must preserve identifiers while changing the amount representation rather than deleting records.", evidence: [{ toolCallId: prepare.id, excerpt: prepare.output.slice(0, 250) }, { toolCallId: verify.id, excerpt: verify.output.slice(0, 200) }] }] },
          value: { transferable: true, nonObvious: true, addsKnowledge: true, rationale: "Preserving stable identifiers while migrating a field type and independently reconciling the contract is a reusable schema migration rule supported by actual file checks.", evidence: [{ toolCallId: prepare.id, excerpt: prepare.output.slice(0, 250) }, { toolCallId: verify.id, excerpt: verify.output.slice(0, 200) }] },
        },
        skill: {
          id: "autoskill-smoke-workflow", name: "autoskill-smoke-workflow",
          description: "Migrate a legacy field representation to a new schema contract while preserving record identifiers.",
          whenToUse: ["When a stored field type conflicts with a new schema contract."], prerequisites: ["Both the legacy records and target contract are available."],
          steps: ["Compare the legacy schema with the target contract and identify the incompatible field.", "Stage the field conversion while preserving existing record identifiers instead of deleting incompatible records.", "Independently read back the converted records and reconcile schema version, field type and identifier invariants."],
          pitfalls: ["Deleting records can satisfy a schema check while losing identity; validate preservation explicitly."], verification: ["Confirm the new schema contract and stable record identifiers both match the independent readback."],
        },
        evidence: [{ toolCallId: prepare.id, excerpt: prepare.output.slice(0, 80), supports: "procedure" }, { toolCallId: verify.id, excerpt: verify.output.slice(0, 80), supports: "verification" }, { toolCallId: code.id, excerpt: "Code Mode verification passed: migrated schema and stable record identifiers match the target contract.", supports: "verification" }],
      }));
    } else if (body.tools?.length) {
      primaryRequests++;
      for (const tool of body.tools) observedTools.add(tool.function?.name ?? tool.name);
      if (!serialized.includes('"tool_call_id":"call_prepare"')) response(res, body, undefined, { id: "call_prepare", name: "smoke_diagnose" });
      else if (!serialized.includes('"tool_call_id":"call_code"')) response(res, body, undefined, { id: "call_code", name: "execute", input: { code: "const migration = await tools.smoke_migrate(); const verification = await tools.smoke_code_verify(); return { migration, verification };" } });
      else if (!serialized.includes('"tool_call_id":"call_verify"')) response(res, body, undefined, { id: "call_verify", name: "smoke_verify" });
      else response(res, body, "The legacy field representation was migrated to the contract while preserving record identifiers, then independently verified. Task complete.");
    } else response(res, body, "AutoSkill integration smoke test");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error), type: "smoke_error" } }));
  }
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;
const reserve = http.createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const serverPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));

try {
  await fs.writeFile(path.join(project, "smoke-result.json"), JSON.stringify({ schemaVersion: 1, items: [{ id: "item-42", amount: "42" }] }));
  await fs.writeFile(path.join(project, "smoke-contract.json"), JSON.stringify({ schemaVersion: 2, amountType: "number", stableId: "item-42" }));
  const fixturePath = path.join(project, ".opencode", "plugins", "smoke", "index.ts");
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, `import * as fs from "node:fs/promises";
import path from "node:path";
export default { id: "autoskill-smoke-fixture", async setup(ctx) {
  await ctx.tool.transform(editor => {
    editor.add({name: "smoke_diagnose", description: "Diagnose the legacy field representation against the independent schema contract.", options:{codemode:false}, input: {type:"object",properties:{},additionalProperties:false}, async execute() {
      const legacy = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-result.json"),"utf8"));
      const contract = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-contract.json"),"utf8"));
      if (legacy.schemaVersion !== 1 || contract.schemaVersion !== 2 || typeof legacy.items[0].amount !== "string") throw new Error("Unexpected migration fixture");
      return {content: "Root cause: smoke-result legacy schema conflicts with smoke-contract because amount is a string instead of a number. Compared deleting incompatible records versus migrating the field; choose staged migration to preserve stable record identifiers."};
    }});
    editor.add({name: "smoke_migrate", description: "Migrate the legacy field to the target contract while preserving record identifiers.", options:{codemode:true}, input: {type:"object",properties:{},additionalProperties:false}, async execute() {
      const legacy = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-result.json"),"utf8"));
      const contract = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-contract.json"),"utf8"));
      if (legacy.items[0].id !== contract.stableId) throw new Error("Stable identifier mismatch");
      const migrated = {...legacy, schemaVersion: contract.schemaVersion, items: legacy.items.map(item => ({...item, amount:Number(item.amount)})), verified:42};
      await fs.writeFile(path.join(ctx.location.directory,"smoke-result.json"),JSON.stringify(migrated));
      return {content: "Migration applied: schemaVersion 2, amount converted to number, stable record item-42 preserved."};
    }});
    editor.add({name: "smoke_verify", description: "Independently read and verify the smoke fixture artifact.", options:{codemode:false}, input: {type:"object",properties:{},additionalProperties:false}, async execute() {
      const result = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-result.json"),"utf8"));
      const contract = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-contract.json"),"utf8"));
      if (result.schemaVersion !== contract.schemaVersion || typeof result.items[0].amount !== contract.amountType || result.items[0].id !== contract.stableId || result.items[0].amount !== 42) throw new Error("Schema migration verification failed");
      return {content: "Verification passed: migrated schema matches the contract; numeric amount 42 and stable record identifier item-42 are preserved."};
    }});
    editor.add({name: "smoke_code_verify", description: "Verify the fixture through Code Mode.", options:{codemode:true}, input: {type:"object",properties:{},additionalProperties:false}, async execute() {
      const result = JSON.parse(await fs.readFile(path.join(ctx.location.directory,"smoke-result.json"),"utf8"));
      if (result.schemaVersion !== 2 || result.items[0].id !== "item-42" || result.items[0].amount !== 42) throw new Error("Code Mode migration verification failed");
      return {content: "Code Mode verification passed: migrated schema and stable record identifiers match the target contract."};
    }});
  });
}};\n`);
  await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({
    update: "disable", share: "disabled", snapshots: false, warming: false,
    plugins: [{ package: packageRoot, options: { debounceMs: 100, cooldownMs: 0, reviewTimeoutMs: 10_000 } }],
    model: "autoskill-smoke/model",
    providers: { "autoskill-smoke": { package: "@opencode/ai/providers/openai-compatible", env: [], settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "local-smoke" }, models: { model: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200_000, output: 4_000 } } } } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }, null, 2));
  startServer(serverPort);
  async function request(route, method = "GET", body, location = false) {
    const password = /server password ([^\r\n]+)/.exec(output)?.[1] ?? environment.OPENCODE_SERVER_PASSWORD;
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("authorization", "Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
    const url = new URL(route, `http://127.0.0.1:${serverPort}`);
    if (location) url.searchParams.set("location[directory]", project);
    const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`OpenCode ${route}: HTTP ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  }
  // Keep smoke runnable from a production tarball without importing the development SDK.
  const client = {
    server: { info: () => request("/api/info") },
    plugin: { list: () => request("/api/plugin", "GET", undefined, true) },
    config: { get: () => request("/api/config", "GET", undefined, true) },
    skill: { list: () => request("/api/skill", "GET", undefined, true) },
    session: {
      create: async (input) => (await request("/api/session", "POST", input)).data,
      get: async (input) => (await request(`/api/session/${encodeURIComponent(input.sessionID)}`)).data,
      prompt: async ({ sessionID, ...input }) => (await request(`/api/session/${encodeURIComponent(sessionID)}/prompt`, "POST", input)).data,
    },
  };
  let serverInfo;
  async function waitForHost() {
    await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`OpenCode exited before startup (${child.exitCode}).`);
      try { serverInfo = await client.server.info(); return true; } catch { return false; }
    }, "Isolated OpenCode server did not start within 30 seconds.");
    let plugins;
    try {
      await until(async () => {
        plugins = await client.plugin.list();
        return plugins.data.some((plugin) => plugin.id === "opencode-autoskill" && plugin.state.status === "active");
      }, "Plugin did not activate.", 20_000);
    } catch {
      throw new Error(`Official CLI did not load package. Phase: ${hostPhase}; PID: ${child.pid}; primaryRequests: ${primaryRequests}; reviewRequests: ${reviewRequests}; Plugins: ${JSON.stringify(plugins)}; isolated config: ${JSON.stringify(await client.config.get())}`);
    }
  }
  await waitForHost();
  const created = await client.session.create({ location: { directory: project }, model: { providerID: "autoskill-smoke", id: "model" }, title: "AutoSkill isolated smoke test" });
  await client.session.prompt({ sessionID: created.id, text: "Diagnose the schema mismatch using smoke_diagnose. Compare preservation with deletion, then use execute to call tools.smoke_migrate and tools.smoke_code_verify. Independently reconcile the schema contract and stable identifiers with smoke_verify. Report completion." });
  await until(async () => firstReviewHeld, "The mock reviewer never received validated direct-tool and Code Mode evidence.", 20_000);
  let queue = new QueueStore(project);
  let state;
  try {
    state = await queue.read();
    assert.ok(Object.values(state.jobs).some((job) => job.sessionId === created.id && job.status === "running" && job.attempts === 1), "live review must be durably claimed before a crash");
    assert.equal(state.capabilities.supported, true);
    assert.equal(state.capabilities.hostVersion, "2.2.7");
  } finally { queue.close(); }
  await stopServer();
  hostPhase = "restart-recovery";
  startServer(serverPort);
  await waitForHost();
  const skillPath = path.join(project, ".opencode", "skills", "autoskill-smoke-workflow", "SKILL.md");
  let saved = false;
  for (let index = 0; index < 120; index++) {
    if (await fs.stat(skillPath).then(() => true, () => false)) { saved = true; break; }
    await delay(250);
  }
  if (!saved) {
    const info = await client.session.get({ sessionID: created.id });
    const state = await fs.readFile(path.join(project, ".opencode", "autoskill", "state.json"), "utf8").catch(() => "No review state");
    throw new Error(`Skill was not saved. Outcome: ${info.outcome}; primary requests: ${primaryRequests}; reviews: ${reviewRequests}; tools: ${[...observedTools].join(",")}; state: ${state}`);
  }
  assert.ok(observedTools.has("autoskill_status") && observedTools.has("autoskill_review"), "both real plugin tools must be registered");
  assert.equal(reviewRequests, 2, "the crashed provider attempt should resume once after restart");
  assert.ok(observedTools.has("execute"), "the real Code Mode execute tool must be available");
  assert.equal(observedTools.has("smoke_code_verify"), false, "Code Mode fixture must remain in the Code Mode catalog");
  let discovered;
  for (let index = 0; index < 40; index++) {
    discovered = await client.skill.list({ location: { directory: project } });
    if (discovered.data.some((skill) => skill.name === "autoskill-smoke-workflow")) break;
    await delay(250);
  }
  assert.ok(discovered.data.some((skill) => skill.name === "autoskill-smoke-workflow"), `saved skill must be discoverable after reload: ${JSON.stringify(discovered)}`);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, "smoke-result.json"), "utf8")).verified, 42);
  queue = new QueueStore(project);
  try {
    await until(async () => {
      state = await queue.read();
      return Object.values(state.jobs).some((job) => job.sessionId === created.id && job.status === "saved" && job.attempts === 2 && job.publication?.stage === "committed");
    }, "Recovered review must commit its skill and durable job result.", 5_000);
  } finally { queue.close(); }
  console.log(JSON.stringify({ passed: true, cli: `OpenCode ${serverInfo.version}`, tools: ["autoskill_status", "autoskill_review"], primaryRequests, reviewRequests, codeMode: true, crashRecovery: true, skillReloaded: true }));
  if (process.env.AUTOSKILL_SMOKE_HOST_DIAGNOSTICS === "1") console.error(await hostDiagnostics());
} catch (error) {
  console.error(String(error));
  console.error(await hostDiagnostics());
  process.exitCode = 1;
} finally {
  await stopServer().catch((error) => { console.error(String(error)); process.exitCode = 1; });
  mock.closeAllConnections();
  await new Promise((resolve) => mock.close(resolve));
  // The absolute root is generated above and never comes from task evidence or configuration.
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("opencode-autoskill-smoke-")) {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}
