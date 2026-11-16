#!/usr/bin/env node
// Real OpenCode admission/context hooks with an isolated loopback model and private fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SkillStore } from "../dist/skills.js";
import { ReuseStore } from "../dist/reuse-store.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-autoskill-reuse-smoke-"));
const project = path.join(temporary, "project"), home = path.join(temporary, "home");
const configDirectory = path.join(home, ".config", "opencode");
await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(configDirectory, { recursive: true }), fs.mkdir(path.join(temporary, "tmp"))]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(name)));
Object.assign(environment, { HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
  OPENCODE_CONFIG_DIR: configDirectory, TMPDIR: path.join(temporary, "tmp"), TMP: path.join(temporary, "tmp"), TEMP: path.join(temporary, "tmp"),
  OPENCODE_SERVER_PASSWORD: "autoskill-local-reuse-smoke" });
let executable = process.env.OPENCODE_BIN ?? "opencode";
if (process.platform === "win32" && !process.env.OPENCODE_BIN) {
  const bundled = path.join(process.env.APPDATA ?? "", "npm", "opencode.exe");
  if (await fs.stat(bundled).then(() => true, () => false)) executable = bundled;
}
const highId = "tenant-invoice-cache-isolation", possibleId = "archive-ledger-partition-reconciliation";
const highQuery = "Tenant invoice cache collision isolation";
const possibleQuery = "Archive ledger partition reconciliation";
const unrelatedQuery = "Describe the seasonal pattern of aurora photographs";
const highMarker = "AUTOSKILL_HIGH_BODY_MARKER", possibleMarker = "AUTOSKILL_POSSIBLE_BODY_MARKER";
const externalMarker = "AUTOSKILL_EXTERNAL_USER_SKILL";
const withTextAttachment = process.env.AUTOSKILL_REUSE_SMOKE_ATTACHMENT === "1";
let child, spawnError, output = "", mockError;
let primaryRequests = 0, reviewerRequests = 0, auxiliaryRequests = 0;
const requestCounts = { high: 0, possible: 0, unrelated: 0 };
const completed = new Set(), observedTools = new Set();
let hostSkills = [];
let nativeCatalogLocation = { system: false, tools: false };
const managedNames = new Set([highId, possibleId, ...Array.from({ length: 14 }, (_, index) => `unrelated-fixture-${index}`)]);

function text(content) { return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : JSON.stringify(content ?? ""); }
function response(res, body, content, call) {
  const id = `chatcmpl_reuse_${Date.now()}`;
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } }] } : { role: "assistant", content };
  const finish = call ? "tool_calls" : "stop";
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [part, reason] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "model", choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "model",
      choices: [{ index: 0, message: call ? { role: "assistant", content: null, tool_calls: [delta.tool_calls[0]] } : { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  }
}
const mock = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages ?? [], serialized = JSON.stringify(messages);
    if (serialized.includes("<task-evidence>")) { reviewerRequests++; throw new Error("Reuse matching must not invoke a review model in this fixture."); }
    if (!body.tools?.length) { auxiliaryRequests++; response(res, body, "AutoSkill reuse smoke"); return; }
    primaryRequests++;
    const lastUser = text(messages.filter((message) => message.role === "user").at(-1)?.content);
    const stage = lastUser.includes(possibleQuery) ? "possible" : lastUser.includes(unrelatedQuery) ? "unrelated" : lastUser.includes(highQuery) ? "high" : undefined;
    assert.ok(stage, `Unexpected user task in primary request: ${lastUser.slice(0, 180)}`);
    requestCounts[stage]++; assert.ok(requestCounts[stage] <= 7, "Reuse must not create an unbounded model loop.");
    for (const tool of body.tools) observedTools.add(tool.function?.name ?? tool.name);
    const systems = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n");
    const descriptions = (body.tools ?? []).map((tool) => tool.function?.description ?? tool.description ?? "").join("\n");
    nativeCatalogLocation.system ||= systems.includes("<available_skills>"); nativeCatalogLocation.tools ||= descriptions.includes("<available_skills>");
    const catalogs = [...`${systems}\n${descriptions}`.matchAll(/<available_skills>[\s\S]*?<\/available_skills>/g)].map((match) => match[0]).join("\n");
    assert.ok(catalogs.includes(externalMarker), "Filtering managed metadata must preserve the external user skill.");
    for (const skill of hostSkills.filter((skill) => managedNames.has(skill.name))) assert.ok(!catalogs.includes(`<id>${skill.id}</id>`), `Managed skill ${skill.name} still appears in the full native catalog.`);
    assert.ok(systems.length < 28_000, "The managed library must not be injected wholesale.");
    assert.ok(!systems.includes("DISTRACTOR_BODY_MARKER"), "Unrelated skill bodies must stay unloaded.");
    const called = (id) => serialized.includes(`"tool_call_id":"${id}"`);
    if (stage === "high") {
      assert.ok(systems.includes(highMarker), "A high match must arrive as actual provider context.");
      assert.ok(!systems.includes(possibleMarker), "An unrelated uncertain skill must remain unloaded.");
      if (!called("reuse_high_apply")) response(res, body, undefined, { id: "reuse_high_apply", name: "reuse_apply", input: { kind: "high" } });
      else if (!called("reuse_high_verify")) response(res, body, undefined, { id: "reuse_high_verify", name: "reuse_verify", input: { kind: "high" } });
      else if (!called("reuse_high_feedback")) response(res, body, undefined, { id: "reuse_high_feedback", name: "autoskill_feedback", input: { skillId: highId, used: true, outcome: "success" } });
      else { completed.add(stage); response(res, body, "Applied the bounded tenant isolation procedure and independently verified the fixture."); }
    } else if (stage === "possible") {
      assert.ok(!systems.includes(highMarker), "The second task must not inherit the first task's skill context.");
      if (!called("reuse_possible_confirm")) {
        assert.ok(!systems.includes(possibleMarker), "Unconfirmed prerequisites must prevent automatic body loading.");
        assert.ok(systems.includes(possibleId), "An uncertain match must still offer a bounded candidate summary.");
        response(res, body, undefined, { id: "reuse_possible_confirm", name: "reuse_confirm" });
      } else if (!called("reuse_possible_load")) response(res, body, undefined, { id: "reuse_possible_load", name: "autoskill_load", input: { skillId: possibleId } });
      else if (!called("reuse_possible_apply")) {
        assert.ok(serialized.includes(possibleMarker), "Explicit loading must return the real shortlisted procedure.");
        response(res, body, undefined, { id: "reuse_possible_apply", name: "reuse_apply", input: { kind: "possible" } });
      } else if (!called("reuse_possible_verify")) response(res, body, undefined, { id: "reuse_possible_verify", name: "reuse_verify", input: { kind: "possible" } });
      else if (!called("reuse_possible_feedback")) response(res, body, undefined, { id: "reuse_possible_feedback", name: "autoskill_feedback", input: { skillId: possibleId, used: true, outcome: "success" } });
      else { completed.add(stage); response(res, body, "Checked the archive precondition, loaded the candidate and independently verified its application."); }
    } else {
      assert.ok(!systems.includes(highMarker) && !systems.includes(possibleMarker), "An unrelated third task must have no stale skill body.");
      completed.add(stage); response(res, body, "The aurora task has no matching project skill.");
    }
  } catch (error) {
    mockError = error;
    res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(error), type: "reuse_smoke_error" } }));
  }
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockPort = mock.address().port;
const reserve = http.createServer(); await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const serverPort = reserve.address().port; await new Promise((resolve) => reserve.close(resolve));
async function until(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (mockError) throw mockError; if (await predicate()) return; await delay(100); }
  throw new Error(message);
}
async function request(route, method = "GET", body, location = false) {
  const password = /server password ([^\r\n]+)/.exec(output)?.[1] ?? environment.OPENCODE_SERVER_PASSWORD;
  const headers = new Headers({ "content-type": "application/json", authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") });
  const url = new URL(route, `http://127.0.0.1:${serverPort}`); if (location) url.searchParams.set("location[directory]", project);
  const result = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (!result.ok) throw new Error(`OpenCode ${route}: HTTP ${result.status} ${await result.text()}`);
  return result.status === 204 ? undefined : result.json();
}
async function stopServer() {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) throw new Error("The isolated reuse host did not stop.");
  }
}
try {
  const store = new SkillStore(project);
  const provenance = { sessionId: "smoke-source", taskId: "smoke-source-task", fingerprint: "smoke-source-fingerprint", messageIds: ["smoke-source-user"], createdAt: new Date().toISOString(), evidence: [] };
  const decision = (id, title, marker, prerequisites = []) => ({ action: "create", taskCompleted: true, reusable: true, confidence: 0.99, reason: "Synthetic trusted skill fixture for host wiring.",
    skill: { id, name: title, description: title, whenToUse: [title], prerequisites,
      steps: [`${marker}: call reuse_apply for the corresponding fixture only after confirming its prerequisites.`, "Use reuse_verify to independently read back the fixture before reporting application success."],
      pitfalls: ["Preserve current user requirements and project boundaries."], verification: ["reuse_verify must report that the actual fixture exists and matches its expected value."] } });
  await store.save(decision(highId, highQuery, highMarker), provenance);
  await store.save(decision(possibleId, possibleQuery, possibleMarker, ["The archive partition key has been confirmed."]), provenance);
  for (let index = 0; index < 14; index++) await store.save(decision(`unrelated-fixture-${index}`, `Orchid bloom texture palette ${index}`, `DISTRACTOR_BODY_MARKER_${index}`), provenance);
  const external = path.join(project, ".opencode/skills/external-user-workflow/SKILL.md");
  await fs.mkdir(path.dirname(external), { recursive: true });
  await fs.writeFile(external, `---\nname: external-user-workflow\ndescription: ${externalMarker}\n---\n# External user workflow\nThis user-owned skill must retain native discovery.\n`);
  await fs.writeFile(path.join(project, "archive-precondition.json"), JSON.stringify({ partitionKeyConfirmed: true }));
  const attachmentPath = path.join(project, "task-context.txt");
  if (withTextAttachment) await fs.writeFile(attachmentPath, "The task uses an isolated synthetic fixture. Preserve the current user request.\n");
  const fixturePath = path.join(project, ".opencode/plugins/reuse-fixture/index.ts");
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, `import * as fs from "node:fs/promises"; import path from "node:path";
export default { id:"autoskill-reuse-fixture",async setup(ctx){
if(${withTextAttachment})await ctx.session.hook("context",async input=>{const user=[...input.messages].reverse().find(message=>message.role==="user");if(user?.content[0]?.text===${JSON.stringify(highQuery)})await fs.writeFile(path.join(ctx.location.directory,"context-shape.json"),JSON.stringify(user.content));});
await ctx.tool.transform(editor=>{
editor.add({name:"reuse_confirm",description:"Read the archive fixture prerequisite independently.",options:{codemode:false},input:{type:"object",properties:{},additionalProperties:false},async execute(){const value=JSON.parse(await fs.readFile(path.join(ctx.location.directory,"archive-precondition.json"),"utf8"));if(value.partitionKeyConfirmed!==true)throw Error("Partition key not confirmed");return {content:"The archive partition key has been confirmed."};}});
for(const name of ["reuse_apply","reuse_verify"])editor.add({name,description:name==="reuse_apply"?"Apply the selected bounded fixture procedure.":"Independently read back the selected fixture result.",options:{codemode:false},input:{type:"object",properties:{kind:{type:"string",enum:["high","possible"]}},required:["kind"],additionalProperties:false},async execute(input){const file=path.join(ctx.location.directory,"reuse-"+input.kind+".json");if(name==="reuse_apply")await fs.writeFile(file,JSON.stringify({kind:input.kind,value:42}));const value=JSON.parse(await fs.readFile(file,"utf8"));if(value.kind!==input.kind||value.value!==42)throw Error("Unexpected reuse fixture result");return {content:name==="reuse_verify"?"Independent fixture verification passed: "+input.kind+" equals 42.":"Applied bounded fixture: "+input.kind+" equals 42."};}});
});}};\n`);
  await fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ update: "disable", share: "disabled", snapshots: false, warming: false,
    plugins: [{ package: packageRoot, options: { debounceMs: 50, cooldownMs: 0, minComplexityScore: 100, reuseMaxContextChars: 8_000, reuseMaxSkillChars: 3_000 } }],
    model: "autoskill-reuse-smoke/model", providers: { "autoskill-reuse-smoke": { package: "@opencode/ai/providers/openai-compatible", env: [],
      settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "local-reuse-smoke" }, models: { model: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200_000, output: 4_000 } } } } },
    permissions: [{ action: "*", resource: "*", effect: "allow" }] }, null, 2));
  child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(serverPort)], { cwd: project, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { output = (output + data).slice(-30_000); }); child.stderr.on("data", (data) => { output = (output + data).slice(-30_000); }); child.on("error", (error) => { spawnError = error; });
  let serverInfo;
  await until(async () => { if (spawnError) throw spawnError; if (child.exitCode !== null) throw Error(`OpenCode exited (${child.exitCode}).`); try { serverInfo = await request("/api/info"); return true; } catch { return false; } }, "Isolated OpenCode reuse host did not start.");
  await until(async () => (await request("/api/plugin", "GET", undefined, true)).data.some((plugin) => plugin.id === "opencode-autoskill" && plugin.state.status === "active"), "AutoSkill reuse plugin did not activate.");
  hostSkills = (await request("/api/skill", "GET", undefined, true)).data;
  assert.ok(hostSkills.length >= 17);
  assert.equal(hostSkills.filter((skill) => managedNames.has(skill.name)).length, 16);
  const session = (await request("/api/session", "POST", { location: { directory: project }, model: { providerID: "autoskill-reuse-smoke", id: "model" }, title: "AutoSkill isolated reuse smoke" })).data;
  for (const [stage, query] of [["high", highQuery], ["possible", possibleQuery], ["unrelated", unrelatedQuery]]) {
    await request(`/api/session/${encodeURIComponent(session.id)}/prompt`, "POST", { text: query,
      ...(withTextAttachment && stage === "high" ? { files: [{ uri: pathToFileURL(attachmentPath).href }] } : {}) });
    await until(async () => { const info = (await request(`/api/session/${encodeURIComponent(session.id)}`)).data;
      return completed.has(stage) && info.outcome === "succeeded" && info.time.idle !== undefined && info.time.idle >= (info.time.busy ?? 0); }, `Reuse task ${stage} did not complete.`);
  }
  const ledger = new ReuseStore(project);
  try {
    let status;
    await until(async () => { status = await ledger.status(); return status.searchedTasks === 3 && status.recent.every((task) => task.outcome === "success"); }, "All three actual task identities must reach the reuse ledger.");
    assert.equal(status.loadedTasks, 2); assert.equal(status.reportedUsedTasks, 2);
    const history = await ledger.history();
    for (const id of [highId, possibleId]) { const entry = history.find((item) => item.skillId === id);
      assert.equal(entry.loaded, 1); assert.equal(entry.reportedUsed, 1); assert.equal(entry.modelFeedback.success, 1); assert.equal(entry.userFeedback.success, 0); }
    const loadSources = status.recent.flatMap((task) => task.skills.filter((skill) => skill.loaded).map((skill) => skill.loadSource));
    assert.ok(loadSources.includes("automatic") && loadSources.includes("explicit"));
    assert.equal(reviewerRequests, 0); assert.ok(primaryRequests <= 13);
    assert.ok(observedTools.has("autoskill_load") && observedTools.has("autoskill_feedback"));
    assert.ok(observedTools.has("autoskill_search"));
    if (withTextAttachment) {
      const parts = JSON.parse(await fs.readFile(path.join(project, "context-shape.json"), "utf8"));
      assert.equal(parts[0].text, highQuery, "The supported host must retain the original task as its first text part.");
      assert.ok(parts.slice(1).some((part) => part.type === "text" && part.text.includes("Attached file: task-context.txt")));
    }
    for (const kind of ["high", "possible"]) assert.equal(JSON.parse(await fs.readFile(path.join(project, `reuse-${kind}.json`), "utf8")).value, 42);
    console.log(JSON.stringify({ passed: true, cli: `OpenCode ${serverInfo.version}`, managedLibrarySize: 16, taskSearches: status.searchedTasks,
      highMatchAutoLoaded: true, uncertainMatchExplicitlyLoaded: true, taskIsolation: true, nativeManagedCatalogFiltered: true, externalSkillPreserved: true,
      actualApplications: 2, modelFeedbackRecordedSeparately: true, primaryRequests, reviewerRequests, auxiliaryRequests, requestCounts, nativeCatalogLocation,
      nativeSkillIdsDifferFromNames: hostSkills.filter((skill) => managedNames.has(skill.name)).some((skill) => skill.id !== skill.name),
      textAttachmentTask: withTextAttachment }));
  } finally { await ledger.close(); }
} catch (error) {
  console.error(String(error)); console.error(output.replace(/server password [^\r\n]+/g, "server password [redacted]")); process.exitCode = 1;
} finally {
  await stopServer().catch((error) => { console.error(String(error)); process.exitCode = 1; }); mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("opencode-autoskill-reuse-smoke-")) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
