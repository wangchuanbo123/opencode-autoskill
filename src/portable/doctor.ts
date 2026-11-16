import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeHost, readPortableConfig, readSafeFile, type PortableHost } from "./install.js";

export async function doctorHost(input: { root: string; host: PortableHost; binary?: string }): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root), host = normalizeHost(input.host), config = await readPortableConfig(root);
  const binary = input.binary ?? ({ opencode: "opencode", "claude-code": "claude", codex: "codex", gemini: "gemini", cursor: "cursor", generic: "" }[host]);
  const probe = binary ? spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false }) : undefined;
  const detected = probe?.status === 0, version = detected ? probe.stdout.trim().slice(0, 500) : undefined;
  const capabilities: Record<PortableHost, Record<string, unknown>> = {
    opencode: { hooks: "native plugin contract", context: "pre-model context hook", restriction: ">=2.2.7 <2.3.0" },
    "claude-code": { hooks: "prompt/tool/stop", context: "UserPromptSubmit hook output", transcript: "host provided path" },
    codex: { hooks: "requires host hooks feature and trusted hook configuration", context: "host hook output; verify installed version", transcript: "host payload dependent" },
    gemini: { hooks: "BeforeAgent/AfterTool/AfterAgent", context: "BeforeAgent hook output", transcript: "host payload dependent" },
    cursor: { hooks: "prompt/tool/stop", context: "session start or post-tool only; no per-prompt pre-model injection", transcript: "optional; may be disabled", cloud: "sessionStart/sessionEnd absent; HTTP MCP result redacted" },
    generic: { hooks: false, context: "model calls MCP tools", transcript: false, automaticDistillation: false },
  };
  const installed = await readSafeFile(path.join(root, ".autoskill", "installations", `${host}.json`)) !== undefined;
  const reviewer = config.reviewer;
  return { host, root, installed, enabled: config.adapters[host]?.enabled ?? false, binary: binary || undefined, detected, version,
    verification: "static configuration and version probe only; hook execution is not verified", capabilities: capabilities[host],
    needsHostTrust: installed && host !== "generic", reviewer: reviewer ? { configured: true, model: reviewer.model, credentialAvailable: reviewer.apiKeyEnv ? !!process.env[reviewer.apiKeyEnv] : undefined } : { configured: false, reason: "Portable automatic review requires a configured reviewer; MCP reuse remains available." },
    checks: [detected || host === "generic" ? "binary-detected-or-not-required" : "binary-not-found", installed ? "configuration-installed" : "configuration-missing", "run a real host task to verify prompt/tool/stop events"] };
}
