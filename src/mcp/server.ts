import { PLUGIN_VERSION } from "../version.js";
import type { PortableRuntime } from "../portable/runtime.js";
import { StringDecoder } from "node:string_decoder";

type Json = Record<string, unknown>;
const string = { type: "string", minLength: 1, maxLength: 128 };
const token = { type: "string", minLength: 36, maxLength: 36, description: "Opaque task contextToken from this task's hook or autoskill_search response." };
const schema = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const MCP_TOOLS = [
  { name: "autoskill_search", description: "Search reusable verified project methods. Returns summaries and a contextToken. Reuse the current task token when provided; a new token creates an explicit search, not an observed host task.", inputSchema: schema({ query: { type: "string", minLength: 1, maxLength: 1500 }, contextToken: token }, ["query"]), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "autoskill_load", description: "Load a shortlisted skill for this exact task after checking prerequisites. Loading does not execute commands, grant permissions, or prove use.", inputSchema: schema({ skillId: string, contextToken: token }, ["skillId", "contextToken"]), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "autoskill_feedback", description: "Report model-observed use of a loaded skill and its outcome. This is a model report, never a user evaluation.", inputSchema: schema({ skillId: string, contextToken: token, used: { type: "boolean" }, outcome: { type: "string", enum: ["success", "failure", "unknown"] } }, ["skillId", "contextToken", "used", "outcome"]), annotations: { destructiveHint: false, openWorldHint: false } },
  { name: "autoskill_status", description: "Show adapter capabilities, reviewer availability, queue and skill status without exposing private task evidence.", inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "autoskill_review", description: "Review a completed task already captured by trusted host hooks. May call the configured reviewer and consume budget. Does not accept model-authored evidence. dryRun previews without publishing.", inputSchema: schema({ contextToken: token, dryRun: { type: "boolean", default: false } }, ["contextToken"]), annotations: { destructiveHint: false, openWorldHint: true } },
];

function argumentsFor(name: string, value: unknown): Json {
  const tool = MCP_TOOLS.find((item) => item.name === name); if (!tool) throw new Error("Unknown AutoSkill tool.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  const args = value as Json; const spec = tool.inputSchema as { properties: Record<string, any>; required: string[] };
  for (const key of Object.keys(args)) if (!Object.hasOwn(spec.properties, key)) throw new Error(`Unknown argument: ${key}`);
  for (const key of spec.required) if (args[key] === undefined) throw new Error(`${key} is required.`);
  for (const [key, item] of Object.entries(spec.properties)) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== item.type || typeof args[key] === "string" && ((args[key] as string).length < (item.minLength ?? 0) || (args[key] as string).length > (item.maxLength ?? Infinity))) throw new Error(`Invalid ${key}.`);
    if (item.enum && !item.enum.includes(args[key])) throw new Error(`Invalid ${key}.`);
  }
  return args;
}

export async function callMcpTool(runtime: PortableRuntime, name: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
  const args = argumentsFor(name, value);
  switch (name) {
    case "autoskill_search": return runtime.search(args.query as string, args.contextToken, signal);
    case "autoskill_load": return runtime.load(args.skillId as string, args.contextToken, signal);
    case "autoskill_feedback": return runtime.feedback(args as { skillId: string; contextToken: string; used: boolean; outcome: "success" | "failure" | "unknown" }, signal);
    case "autoskill_status": return runtime.status();
    case "autoskill_review": return runtime.review(args.contextToken, args.dryRun === true, signal);
    default: throw new Error("Unknown AutoSkill tool.");
  }
}

/** MCP stdio uses newline-delimited JSON-RPC. Nothing except protocol data goes to stdout. */
export async function serveMcp(runtime: PortableRuntime, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (value: unknown) => output.write(JSON.stringify(value) + "\n");
  let initialized = false, buffer = "", serial = Promise.resolve();
  const active = new Map<string | number, AbortController>();
  const cancelled = new Set<string | number>();
  const decoder = new StringDecoder("utf8");
  const handle = async (request: Json) => {
    const id = request.id as string | number | undefined;
    const response = (result: unknown) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
    const fail = (code: number, message: string) => { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message } }); };
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { fail(-32600, "Invalid Request"); return; }
    if (id !== undefined && typeof id !== "string" && typeof id !== "number") { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request ID" } }); return; }
    const params = request.params as Json | undefined;
    if (request.method === "notifications/cancelled") {
      const target = params?.requestId;
      if (typeof target === "string" || typeof target === "number") {
        const controller = active.get(target); if (controller) controller.abort(); else if (cancelled.size < 1024) cancelled.add(target);
      }
      return;
    }
    if (request.method.startsWith("notifications/")) return;
    if (request.method === "initialize") {
      if (initialized) { fail(-32600, "Already initialized"); return; }
      const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
      initialized = true; response({ protocolVersion: versions.includes(String(params?.protocolVersion)) ? params!.protocolVersion : versions[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "autoskill", version: PLUGIN_VERSION },
        instructions: "Search for the current user task, check prerequisites, and load only relevant candidates. Context tokens belong to one task. Feedback is model-reported. AutoSkill never executes skill commands." }); return;
    }
    if (!initialized) { fail(-32002, "Initialize AutoSkill first."); return; }
    if (request.method === "ping") { response({}); return; }
    if (request.method === "tools/list") { response({ tools: MCP_TOOLS }); return; }
    if (request.method === "resources/list" || request.method === "resources/templates/list" || request.method === "prompts/list") { response({ [request.method === "prompts/list" ? "prompts" : request.method === "resources/list" ? "resources" : "resourceTemplates"]: [] }); return; }
    if (request.method !== "tools/call") { fail(-32601, "Method not found"); return; }
    const controller = new AbortController(); if (id !== undefined) active.set(id, controller);
    if (id !== undefined && cancelled.delete(id)) controller.abort();
    const timer = setTimeout(() => controller.abort(), 100_000);
    try {
      controller.signal.throwIfAborted();
      const result = await callMcpTool(runtime, String(params?.name), params?.arguments ?? {}, controller.signal);
      response({ content: [{ type: "text", text: JSON.stringify(result) }], ...(result && typeof result === "object" && !Array.isArray(result) ? { structuredContent: result } : {}) });
    } catch (error) { response({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "AutoSkill tool failed." }] }); }
    finally { clearTimeout(timer); if (id !== undefined) active.delete(id); }
  };
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 1_048_576) throw new Error("MCP input exceeds 1 MiB.");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
      let request: Json;
      try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); request = parsed as Json; }
      catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      if (request.method === "notifications/cancelled") { await handle(request); continue; }
      serial = serial.then(() => handle(request));
    }
  }
  await serial;
}
