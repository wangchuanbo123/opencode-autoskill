import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveStorageLayout } from "../storage-layout.js";
import { assertSafePath, normalizeHost, readPortableConfig, inspectHostInstallation } from "./install.js";
function probeBinary(binary, args) {
    const options = { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false, maxBuffer: 1_048_576 };
    let result = spawnSync(binary, args, options);
    // npm installs expose .ps1/.cmd shims on Windows. Shell-free CreateProcess
    // cannot launch these. A single-quoted PowerShell invocation safely resolves
    // such shims without interpolating the executable path as shell code.
    if (process.platform === "win32" && result.error && /^(?:ENOENT|EINVAL)$/.test(result.error.code ?? "")) {
        if (/[\0\r\n]/.test(binary))
            throw new Error("Invalid binary path.");
        result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; & '${binary.replaceAll("'", "''")}' ${args.map(arg => `'${arg.replaceAll("'", "''")}'`).join(" ")}`], options);
    }
    return result;
}
async function observationFor(root, host) {
    const file = path.join(resolveStorageLayout(root).stateRoot, "events.sqlite");
    await assertSafePath(file);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Unsafe event database.");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
    try {
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adapter_observations'").get();
        if (!table)
            return undefined;
        const row = db.prepare("SELECT value FROM adapter_observations WHERE host=?").get(host);
        if (!row)
            return undefined;
        const value = JSON.parse(row.value);
        return { lastEventAt: value.lastEventAt, eventName: value.eventName, coverage: value.coverage };
    }
    finally {
        db.close();
    }
}
function nativeOpenCodeStatus(root) {
    const entry = fileURLToPath(new URL("../../bin/autoskill.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [entry, "status", "--project", root], { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 1_048_576 });
    if (result.status !== 0)
        return { installed: false, enabled: false, available: false };
    try {
        const value = JSON.parse(result.stdout);
        return { installed: value.installed === true, enabled: value.enabled === true, matchingEntries: Number.isInteger(value.matchingEntries) ? value.matchingEntries : undefined, available: true };
    }
    catch {
        return { installed: false, enabled: false, available: false };
    }
}
export async function doctorHost(input) {
    const root = path.resolve(input.root), host = normalizeHost(input.host), config = await readPortableConfig(root);
    const binary = input.binary ?? ({ opencode: process.env.OPENCODE_BIN ?? "opencode", "claude-code": "claude", codex: "codex", gemini: "gemini", cursor: "cursor", generic: "" }[host]);
    const probe = binary ? probeBinary(binary, ["--version"]) : undefined;
    const help = binary && probe?.status === 0 ? probeBinary(binary, ["--help"]) : undefined;
    const codexFeatures = host === "codex" && probe?.status === 0 ? probeBinary(binary, ["features", "list"]) : undefined;
    const codexHookFeature = /^(?:codex_hooks|hooks)\s+(\S+)\s+(true|false)\s*$/mi.exec(codexFeatures?.stdout ?? "");
    // Do not echo arbitrary stdout/stderr from a version probe: wrappers sometimes
    // print environment/configuration diagnostics before the actual version.
    const detected = probe?.status === 0, version = detected ? /\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,80})?)\b/.exec(probe.stdout)?.[1] : undefined;
    const capabilities = {
        opencode: { hooks: "native plugin contract", context: "pre-model context hook", restriction: ">=2.2.7 <2.3.0" },
        "claude-code": { hooks: "prompt/tool/stop", context: "UserPromptSubmit hook output", transcript: "host provided path" },
        codex: { hooks: "requires host hooks feature and trusted hook configuration", context: "host hook output; verify installed version", transcript: "host payload dependent" },
        gemini: { hooks: "BeforeAgent/AfterTool/AfterAgent", context: "BeforeAgent hook output", transcript: "host payload dependent" },
        cursor: { hooks: "prompt/tool/stop", context: "session start or post-tool only; no per-prompt pre-model injection", transcript: "optional; may be disabled", cloud: "sessionStart/sessionEnd absent; HTTP MCP result redacted" },
        generic: { hooks: false, context: "model calls MCP tools", transcript: false, automaticDistillation: false },
    };
    const native = host === "opencode" ? nativeOpenCodeStatus(root) : undefined;
    const configuration = native ? undefined : await inspectHostInstallation(root, host);
    const installed = native ? native.installed : configuration.installed;
    const configuredEnabled = native ? native.enabled && config.adapters.opencode?.enabled !== false : config.adapters[host]?.enabled ?? false;
    const globallyEnabled = config.options.enabled !== false;
    const enabled = installed && configuredEnabled && globallyEnabled;
    let observed, observationError;
    try {
        observed = await observationFor(root, host);
    }
    catch {
        observationError = "Hook observations could not be read; inspect the private event database.";
    }
    const reviewer = config.reviewer;
    const repair = configuration?.repairable ? { safe: true, reason: "Only absent owned contributions will be restored; modified contributions are protected.", preview: { command: "autoskill", args: ["install", "--host", host, "--project", root, "--dry-run"] }, apply: { command: "autoskill", args: ["install", "--host", host, "--project", root] } } : undefined;
    return { host, root, installed, installationRecorded: native ? native.installed : configuration.recorded, installedMeaning: native ? "native OpenCode plugin reference detected in project configuration" : "all recorded owned contributions match actual host configuration; host execution requires observation", ...(native ? { nativeStatusAvailable: native.available, matchingEntries: native.matchingEntries } : { configuration, ...(repair ? { repair } : {}) }), observed: observed ?? null, verified: false, observationError, enabled, configuredEnabled, globallyEnabled, declaredCapabilities: config.adapters[host]?.capabilities ?? [], agentPolicy: config.agentPolicy,
        childPublication: host === "opencode" ? "core independent policy supported subject to evidence and eligibility checks" : "independent child publication unavailable; portable adapters use root-only/inherit where host evidence is verified", binary: binary || undefined, detected, version,
        verification: "static configuration and version probe only; hook execution is not verified", capabilities: capabilities[host],
        featureProbe: { helpAvailable: help?.status === 0, mcpMentioned: /\bmcp\b/i.test(help?.stdout ?? ""), hooksMentioned: /\bhooks?\b/i.test(help?.stdout ?? ""), ...(host === "codex" ? { featureListAvailable: codexFeatures?.status === 0, codexHooks: codexHookFeature ? { stage: codexHookFeature[1], enabled: codexHookFeature[2] === "true" } : "not-reported" } : {}), meaning: "CLI observations only; absence does not establish unsupported capability, presence does not verify hook execution." },
        needsHostTrust: installed && host !== "generic", reviewer: host === "opencode" ? { type: "native-host-model", configuredByHost: true } : reviewer ? { configured: true, model: reviewer.model, credentialAvailable: reviewer.apiKeyEnv ? !!process.env[reviewer.apiKeyEnv] : undefined } : { configured: false, reason: "Portable automatic review requires a configured reviewer; MCP reuse remains available." },
        checks: [detected || host === "generic" ? "binary-detected-or-not-required" : "binary-not-found", installed ? "configuration-installed" : configuration?.state === "drifted" ? "configuration-drifted" : configuration?.state === "inactive" ? "configuration-inactive" : "configuration-missing", "run a real host task to verify prompt/tool/stop events"] };
}
//# sourceMappingURL=doctor.js.map