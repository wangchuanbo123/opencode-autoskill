import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

export type PortableHost = "opencode" | "claude-code" | "codex" | "gemini" | "cursor" | "generic";
export const portableHosts: PortableHost[] = ["opencode", "claude-code", "codex", "gemini", "cursor", "generic"];
export interface PortableConfig {
  schemaVersion: 1;
  adapters: Partial<Record<PortableHost, { enabled: boolean; mode?: "native" | "mcp" | "hooks" }>>;
  options: Record<string, unknown>;
  reviewer?: { type: "openai-compatible"; baseUrl: string; model: string; apiKeyEnv?: string };
  agentPolicy: "root-only" | "inherit" | "independent";
}
export const defaultPortableConfig = (): PortableConfig => ({ schemaVersion: 1, adapters: {}, options: {}, agentPolicy: "root-only" });
export function normalizeHost(value: string): PortableHost {
  const alias: Record<string, PortableHost> = { claude: "claude-code", "claude-code": "claude-code", mcp: "generic", generic: "generic", opencode: "opencode", codex: "codex", gemini: "gemini", cursor: "cursor" };
  const host = alias[value.toLowerCase()];
  if (!host) throw new Error(`Unsupported host: ${value}. Choose ${portableHosts.join(", ")}.`);
  return host;
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export async function readSafeFile(file: string, max = 4_000_000): Promise<string | undefined> {
  await assertSafePath(file);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`Unsafe or oversized file: ${file}`);
    return await fs.readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Check every existing ancestor, including junctions, before touching a host configuration. */
export async function assertSafePath(file: string): Promise<void> {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  const parts = path.relative(current, absolute).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Refusing symbolic link or non-directory ancestor: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
export async function writeSafeFile(file: string, content: string | Buffer, expected?: string | null): Promise<void> {
  await assertSafePath(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await assertSafePath(file);
  if (expected !== undefined) {
    const current = await readSafeFile(file);
    if ((current === undefined ? null : sha256(current)) !== expected) throw new Error(`File changed during operation: ${file}`);
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await assertSafePath(file);
    if (expected !== undefined) {
      const current = await readSafeFile(file);
      if ((current === undefined ? null : sha256(current)) !== expected) throw new Error(`File changed during operation: ${file}`);
    }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export function parseObject(text: string, label: string): Record<string, any> {
  const errors: any[] = []; const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSON object: ${label}`);
  return value;
}
export async function readPortableConfig(root: string): Promise<PortableConfig> {
  const file = path.join(path.resolve(root), ".autoskill", "config.json");
  const text = await readSafeFile(file); if (text === undefined) return defaultPortableConfig();
  const value = parseObject(text, file);
  if (value.schemaVersion !== 1 || !value.adapters || typeof value.adapters !== "object" || Array.isArray(value.adapters) || !value.options || typeof value.options !== "object" || Array.isArray(value.options) || !["root-only", "inherit", "independent"].includes(value.agentPolicy)) throw new Error("Invalid portable AutoSkill configuration.");
  for (const [host, adapter] of Object.entries(value.adapters)) {
    normalizeHost(host); if (!adapter || typeof adapter !== "object" || typeof (adapter as any).enabled !== "boolean") throw new Error(`Invalid adapter: ${host}`);
  }
  if (value.reviewer && (value.reviewer.type !== "openai-compatible" || ![value.reviewer.baseUrl, value.reviewer.model].every(v => typeof v === "string" && v.trim()) || value.reviewer.apiKeyEnv !== undefined && typeof value.reviewer.apiKeyEnv !== "string")) throw new Error("Invalid reviewer configuration.");
  return value as PortableConfig;
}
export async function hasLegacyData(root: string): Promise<boolean> {
  for (const directory of [path.join(root, ".opencode", "autoskill"), path.join(root, ".opencode", "skills")]) {
    await assertSafePath(directory);
    try { if ((await fs.readdir(directory)).length) return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}
function shellArg(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Hook arguments cannot contain line breaks or NUL.");
  if (process.platform === "win32") {
    // Windows hooks use the command processor. Percent expansion cannot be escaped
    // uniformly across host shells; refuse it rather than execute a different path.
    if (/["%!`$]/.test(value)) throw new Error("A hook path contains shell expansion characters; install the package/project under a plain path.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function portableCommand(root: string, host: PortableHost, command: "hook" | "serve", event?: string, packageDir?: string): string {
  const entry = path.join(packageDir ?? fileURLToPath(new URL("../../", import.meta.url)), "bin", "autoskill.mjs");
  return [process.execPath, entry, command, "--host", host, ...(event ? ["--event", event] : []), "--project", path.resolve(root)].map(shellArg).join(" ");
}
const events: Partial<Record<PortableHost, string[]>> = {
  "claude-code": ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop"],
  codex: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SubagentStart", "SubagentStop"],
  gemini: ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
  cursor: ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop", "subagentStart", "subagentStop"],
};
interface OwnedChange { file: string; key?: (string | number)[]; kind: "field" | "array" | "toml"; installed: any; before?: any; beforePresent?: boolean; hash: string; }
interface Manifest { schemaVersion: 1; host: PortableHost; changes: OwnedChange[]; }
function at(value: any, key: (string | number)[]): any { for (const part of key) value = value?.[part]; return value; }
function edit(text: string, key: (string | number)[], value: any): string { return applyEdits(text, modify(text, key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } })); }
function equal(a: any, b: any): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function hashValue(value: any): string { return sha256(JSON.stringify(value)); }
export interface InstallHostOptions { root: string; host: PortableHost; action?: "install" | "uninstall" | "enable" | "disable"; packageDir?: string; dryRun?: boolean; }

/** Apply only owned leaf fields/array entries; unrelated host configuration survives uninstall. */
export async function installHost(input: InstallHostOptions): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root), host = normalizeHost(input.host), action = input.action ?? "install";
  if (host === "opencode") return { host, status: "delegate", action, reason: "Use the OpenCode native installer." };
  const configFile = path.join(root, ".autoskill", "config.json"), configBefore = await readSafeFile(configFile);
  if (configBefore === undefined && await hasLegacyData(root)) throw new Error("Legacy AutoSkill data exists. Run autoskill migrate before installing a portable adapter.");
  const config = await readPortableConfig(root);
  const manifestFile = path.join(root, ".autoskill", "installations", `${host}.json`);
  const manifestText = await readSafeFile(manifestFile), manifest = manifestText ? parseObject(manifestText, manifestFile) as unknown as Manifest : { schemaVersion: 1 as const, host, changes: [] };
  if (manifest.host !== host || manifest.schemaVersion !== 1 || !Array.isArray(manifest.changes)) throw new Error("Invalid host installation manifest.");
  const files = new Map<string, { before: string | undefined; after: string }>();
  const read = async (relative: string) => {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Installation path escapes project.");
    if (!files.has(relative)) { const before = await readSafeFile(path.join(root, relative)); files.set(relative, { before, after: before ?? "{}\n" }); }
    return files.get(relative)!;
  };
  const removing = action === "uninstall" || action === "disable";
  // Remove the previous owned contribution first, then install the new definition.
  for (const change of manifest.changes) {
    const file = await read(change.file);
    if (change.kind === "toml") {
      if (!file.after.includes(change.installed) || sha256(change.installed) !== change.hash) throw new Error(`Managed TOML block changed: ${change.file}`);
      file.after = file.after.replace(change.installed, "");
    } else {
      if (!change.key || hashValue(change.installed) !== change.hash) throw new Error("Invalid owned configuration record.");
      const value = at(parseObject(file.after, change.file), change.key);
      if (change.kind === "array") {
        if (!Array.isArray(value) || !value.some(v => equal(v, change.installed))) throw new Error(`Managed hook changed: ${change.file}`);
        const remaining = [...value]; remaining.splice(remaining.findIndex(v => equal(v, change.installed)), 1);
        file.after = edit(file.after, change.key, remaining.length || change.beforePresent ? remaining : undefined);
      } else {
        if (!equal(value, change.installed)) throw new Error(`Managed configuration changed: ${change.file}`);
        file.after = edit(file.after, change.key, change.beforePresent ? change.before : undefined);
      }
    }
  }
  const changes: OwnedChange[] = [];
  const add = async (fileName: string, key: (string | number)[], installed: any, kind: "field" | "array" = "field") => {
    const file = await read(fileName), before = at(parseObject(file.after, fileName), key);
    if (kind === "field" && before !== undefined && !equal(before, installed)) throw new Error(`Existing autoskill server conflicts in ${fileName}; no configuration was written.`);
    if (kind === "array" && before !== undefined && !Array.isArray(before)) throw new Error(`Expected hook array in ${fileName}.`);
    file.after = edit(file.after, key, kind === "array" ? [...(before ?? []), installed] : installed);
    changes.push({ file: fileName, key, kind, installed, before, beforePresent: before !== undefined, hash: hashValue(installed) });
  };
  if (!removing) {
    const entry = path.join(input.packageDir ?? fileURLToPath(new URL("../../", import.meta.url)), "bin", "autoskill.mjs");
    const server = { command: process.execPath, args: [entry, "serve", "--host", host, "--project", root] };
    if (host === "codex") {
      const name = ".codex/config.toml", file = await read(name); if (file.before === undefined) file.after = "";
      if (/^\s*\[\s*mcp_servers\s*\.\s*["']?autoskill["']?\s*\]/m.test(file.after) || /\bautoskill\s*=/.test(file.after)) throw new Error("Existing Codex autoskill MCP configuration conflicts; no configuration was written.");
      const block = `\n# BEGIN AUTOSKILL MANAGED MCP\n[mcp_servers.autoskill]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(server.args)}\n# END AUTOSKILL MANAGED MCP\n`;
      file.after += block; changes.push({ file: name, kind: "toml", installed: block, hash: sha256(block) });
    } else {
      const file = host === "claude-code" ? ".mcp.json" : host === "gemini" ? ".gemini/settings.json" : host === "cursor" ? ".cursor/mcp.json" : ".autoskill/mcp.json";
      await add(file, ["mcpServers", "autoskill"], server);
    }
    for (const event of events[host] ?? []) {
      const command = portableCommand(root, host, "hook", event, input.packageDir);
      const hook = host === "cursor" ? { command } : { matcher: "", hooks: [{ type: "command", command, ...(host === "gemini" ? { name: `autoskill-${event}`, timeout: 5000 } : { timeout: 5 }) }] };
      const file = host === "claude-code" ? ".claude/settings.json" : host === "codex" ? ".codex/hooks.json" : host === "gemini" ? ".gemini/settings.json" : ".cursor/hooks.json";
      await add(file, ["hooks", event], hook, "array");
      if (host === "cursor") {
        const cursorFile = await read(file), value = parseObject(cursorFile.after, file);
        if (value.version === undefined) await add(file, ["version"], 1);
      }
    }
  }
  const enabled = !removing;
  let configAfter = configBefore ?? JSON.stringify(config, null, 2) + "\n";
  configAfter = edit(configAfter, ["adapters", host], { ...(config.adapters[host] ?? {}), enabled, mode: host === "generic" ? "mcp" : "hooks" });
  const writes = [...files].filter(([, file]) => file.before !== file.after).map(([file, value]) => ({ file, ...value }));
  if (!input.dryRun) {
    const backupId = `${Date.now()}-${randomUUID()}`;
    for (const write of writes) if (write.before !== undefined) await writeSafeFile(path.join(root, ".autoskill", "config-backups", backupId, write.file), write.before, null);
    // Validate all CAS expectations before the first host mutation.
    for (const write of writes) if ((await readSafeFile(path.join(root, write.file))) !== write.before) throw new Error("Host configuration changed; retry installation.");
    const committed: typeof writes = [];
    try {
      for (const write of writes) { await writeSafeFile(path.join(root, write.file), write.after, write.before === undefined ? null : sha256(write.before)); committed.push(write); }
      await writeSafeFile(manifestFile, JSON.stringify({ schemaVersion: 1, host, changes }, null, 2) + "\n", manifestText === undefined ? null : sha256(manifestText));
      await writeSafeFile(configFile, configAfter, configBefore === undefined ? null : sha256(configBefore));
    } catch (error) {
      for (const write of committed.reverse()) {
        const file = path.join(root, write.file);
        if (await readSafeFile(file) === write.after) { if (write.before === undefined) await fs.unlink(file); else await writeSafeFile(file, write.before, sha256(write.after)); }
      }
      throw error;
    }
  }
  return { host, action, status: input.dryRun ? "dry-run" : "configured", enabled, files: writes.map(item => item.file), needsHostTrust: enabled && host !== "generic", verification: "configuration-written; host execution not verified" };
}
