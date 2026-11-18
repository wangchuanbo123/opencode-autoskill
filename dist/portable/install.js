import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { validateReviewer } from "./reviewer.js";
import { readOptions } from "../config.js";
export const portableHosts = ["opencode", "claude-code", "codex", "gemini", "cursor", "generic"];
export const defaultPortableConfig = () => ({ schemaVersion: 1, adapters: {}, options: {}, agentPolicy: "root-only" });
export function normalizeHost(value) {
    const alias = { claude: "claude-code", "claude-code": "claude-code", mcp: "generic", generic: "generic", opencode: "opencode", codex: "codex", gemini: "gemini", cursor: "cursor" };
    const host = alias[value.toLowerCase()];
    if (!host)
        throw new Error(`Unsupported host: ${value}. Choose ${portableHosts.join(", ")}.`);
    return host;
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export async function readSafeFile(file, max = 4_000_000) {
    await assertSafePath(file);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
            throw new Error(`Unsafe or oversized file: ${file}`);
        return await fs.readFile(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
/** Check every existing ancestor, including junctions, before touching a host configuration. */
export async function assertSafePath(file) {
    const absolute = path.resolve(file);
    let current = path.parse(absolute).root;
    const parts = path.relative(current, absolute).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i]);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory())
                throw new Error(`Refusing symbolic link or non-directory ancestor: ${current}`);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
    }
}
export async function writeSafeFile(file, content, expected, maxExistingBytes = 4_000_000) {
    await assertSafePath(file);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await assertSafePath(file);
    if (expected !== undefined) {
        const current = await readSafeFile(file, maxExistingBytes);
        if ((current === undefined ? null : sha256(current)) !== expected)
            throw new Error(`File changed during operation: ${file}`);
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
        await assertSafePath(file);
        if (expected !== undefined) {
            const current = await readSafeFile(file, maxExistingBytes);
            if ((current === undefined ? null : sha256(current)) !== expected)
                throw new Error(`File changed during operation: ${file}`);
        }
        await fs.rename(temp, file);
    }
    finally {
        await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT")
            throw error; });
    }
}
export async function withPortableLock(root, name, operation) {
    if (!/^[a-z0-9-]+$/.test(name))
        throw new Error("Invalid portable lock name.");
    const directory = path.join(path.resolve(root), ".autoskill", "operation-locks");
    await assertSafePath(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertSafePath(directory);
    const file = path.join(directory, `${name}.lock`);
    const handle = await fs.open(file, "wx", 0o600).catch(error => { if (error.code === "EEXIST")
        throw new Error(`Portable ${name} operation is locked. Stop hosts and inspect ${file} before retrying.`); throw error; });
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        return await operation();
    }
    finally {
        await handle.close();
        await fs.unlink(file);
    }
}
/** Runtime receipts and configuration backups can contain private host data. */
export async function ensurePortablePrivate(root) {
    const file = path.join(path.resolve(root), ".autoskill", ".gitignore"), before = await readSafeFile(file);
    const required = ["runtime/", "config-backups/", "installations/", "operation-locks/", "exports/", ".migration-*/", "migration.lock", "*.rolled-back-*/", "config.rolled-back-*.json"];
    const lines = new Set((before ?? "").split(/\r?\n/).map(line => line.trim()));
    const missing = required.filter(line => !lines.has(line));
    if (!missing.length)
        return;
    await writeSafeFile(file, `${before ?? ""}${before && !before.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, before === undefined ? null : sha256(before));
}
export function parseObject(text, label) {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid JSON object: ${label}`);
    return value;
}
export async function readPortableConfig(root) {
    const file = path.join(path.resolve(root), ".autoskill", "config.json");
    const text = await readSafeFile(file);
    if (text === undefined)
        return defaultPortableConfig();
    const value = parseObject(text, file);
    if (Object.keys(value).some(key => !["schemaVersion", "adapters", "options", "reviewer", "agentPolicy"].includes(key)))
        throw new Error("Unknown portable AutoSkill configuration field.");
    if (value.schemaVersion !== 1 || !value.adapters || typeof value.adapters !== "object" || Array.isArray(value.adapters) || !value.options || typeof value.options !== "object" || Array.isArray(value.options) || !["root-only", "inherit", "independent"].includes(value.agentPolicy))
        throw new Error("Invalid portable AutoSkill configuration.");
    for (const [host, adapter] of Object.entries(value.adapters)) {
        if (normalizeHost(host) !== host || !adapter || typeof adapter !== "object" || Array.isArray(adapter) || Object.keys(adapter).some(key => !["enabled", "mode", "capabilities"].includes(key)) || typeof adapter.enabled !== "boolean")
            throw new Error(`Invalid adapter: ${host}`);
        if (adapter.mode !== undefined && !["native", "mcp", "hooks"].includes(adapter.mode))
            throw new Error(`Invalid adapter mode: ${host}`);
        const capabilities = adapter.capabilities;
        if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some(item => typeof item !== "string" || item.length > 80 || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(item))))
            throw new Error(`Invalid adapter capabilities: ${host}`);
    }
    readOptions(value.options);
    if (value.reviewer) {
        if (typeof value.reviewer !== "object" || Array.isArray(value.reviewer) || Object.keys(value.reviewer).some(key => !["type", "baseUrl", "model", "apiKeyEnv", "maxOutputTokens"].includes(key)))
            throw new Error("Invalid reviewer configuration; credentials must use apiKeyEnv.");
        validateReviewer(value.reviewer);
    }
    return value;
}
export async function hasLegacyData(root) {
    for (const directory of [path.join(root, ".opencode", "autoskill"), path.join(root, ".opencode", "skills")]) {
        await assertSafePath(directory);
        try {
            if ((await fs.readdir(directory)).length)
                return true;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return false;
}
function shellArg(value) {
    if (/[\0\r\n]/.test(value))
        throw new Error("Hook arguments cannot contain line breaks or NUL.");
    return `'${value.replaceAll("'", "'\\''")}'`;
}
export function portableCommand(root, host, command, event, packageDir) {
    const entry = packageEntry(packageDir);
    const args = [process.execPath, entry, command, "--host", host, ...(event ? ["--event", event] : []), "--project", path.resolve(root)];
    if (process.platform === "win32") {
        // A quoted executable alone is not an invocation in PowerShell. Explicitly
        // launch PowerShell with an encoded script, which is also valid when a host
        // starts the outer command through cmd.exe or Bash. All variable path data
        // stays inside single-quoted literals; only base64 crosses the outer shell.
        const literals = args.map(value => { if (/[\0\r\n]/.test(value))
            throw new Error("Invalid hook argument."); return `'${value.replaceAll("'", "''")}'`; });
        const script = `& ${literals.join(" ")}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
        return `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
    }
    return args.map(shellArg).join(" ");
}
const events = {
    "claude-code": ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop"],
    codex: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt", "SubagentStart", "SubagentStop"],
    gemini: ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
    cursor: ["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop", "subagentStart", "subagentStop"],
};
function at(value, key) { for (const part of key)
    value = value?.[part]; return value; }
function edit(text, key, value) { return applyEdits(text, modify(text, key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } })); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function hashValue(value) { return sha256(JSON.stringify(value)); }
function packageEntry(packageDir) { return path.join(path.resolve(packageDir ?? fileURLToPath(new URL("../../", import.meta.url))), "bin", "autoskill.mjs"); }
function parseTomlConfig(text, label) {
    // Inspect structure without serializing it again: comments, formatting and
    // large integer values in unrelated user settings must remain untouched.
    try {
        return parseToml(text, { integersAsBigInt: "asNeeded" });
    }
    catch {
        throw new Error(`Invalid TOML configuration: ${label}; no configuration was written.`);
    }
}
function validateChange(change) {
    if (!change || typeof change.file !== "string" || path.isAbsolute(change.file) || change.file.split(/[\\/]/).includes("..") || !["field", "array", "toml"].includes(change.kind))
        throw new Error("Invalid owned configuration record.");
    if (change.kind === "toml") {
        if (typeof change.installed !== "string" || !change.installed || sha256(change.installed) !== change.hash)
            throw new Error("Invalid owned TOML record.");
    }
    else if (!change.key?.length || change.key.some(part => typeof part !== "string" && !(typeof part === "number" && Number.isInteger(part) && part >= 0)) || change.installed === undefined || hashValue(change.installed) !== change.hash)
        throw new Error("Invalid owned configuration record.");
}
function ownedValue(value, key) {
    for (const part of key) {
        if (!value || typeof value !== "object")
            return { blocked: true };
        if (!Object.hasOwn(value, part))
            return {};
        value = value[part];
    }
    return { value };
}
function inspectChange(change, text) {
    const detail = { file: change.file, ...(change.key ? { key: change.key } : {}), kind: change.kind };
    if (text === undefined)
        return { ...detail, state: "missing", reason: "file-missing" };
    let value;
    try {
        value = change.kind === "toml" ? parseTomlConfig(text, change.file) : parseObject(text, change.file);
    }
    catch {
        return { ...detail, state: "invalid", reason: "configuration-invalid" };
    }
    if (change.kind === "toml") {
        if (text.includes(change.installed))
            return { ...detail, state: "present" };
        const current = ownedValue(value, ["mcp_servers", "autoskill"]);
        return current.value === undefined && !current.blocked ? { ...detail, state: "missing", reason: "contribution-missing" } : { ...detail, state: "modified", reason: "managed-block-changed" };
    }
    const current = ownedValue(value, change.key);
    if (current.value === undefined && !current.blocked)
        return { ...detail, state: "missing", reason: "contribution-missing" };
    if (change.kind === "array") {
        if (Array.isArray(current.value) && current.value.some(item => equal(item, change.installed)))
            return { ...detail, state: "present" };
        // An empty array or the original untouched array proves the owned hook was
        // removed. An unfamiliar entry could be an edited hook, so leave it alone.
        if (Array.isArray(current.value) && (!current.value.length || equal(current.value, change.before)))
            return { ...detail, state: "missing", reason: "contribution-missing" };
    }
    else if (equal(current.value, change.installed))
        return { ...detail, state: "present" };
    return { ...detail, state: "modified", reason: "managed-value-changed" };
}
async function readManifest(root, host) {
    const file = path.join(root, ".autoskill", "installations", `${host}.json`), text = await readSafeFile(file);
    const manifest = text === undefined ? { schemaVersion: 1, host, changes: [] } : parseObject(text, file);
    if (manifest.host !== host || manifest.schemaVersion !== 1 || !Array.isArray(manifest.changes))
        throw new Error("Invalid host installation manifest.");
    manifest.changes.forEach(validateChange);
    return { file, text, manifest };
}
/** Inspect actual owned fields rather than treating an installation receipt as proof. */
export async function inspectHostInstallation(root, host) {
    const { text, manifest } = await readManifest(path.resolve(root), host), contributions = [];
    const files = new Map();
    for (const change of manifest.changes) {
        if (!files.has(change.file))
            files.set(change.file, await readSafeFile(path.join(root, change.file)));
        contributions.push(inspectChange(change, files.get(change.file)));
    }
    const installed = contributions.length > 0 && contributions.every(change => change.state === "present");
    const drifted = contributions.some(change => change.state === "modified" || change.state === "invalid");
    const missing = contributions.some(change => change.state === "missing");
    return { recorded: text !== undefined, installed, state: text === undefined ? "not-recorded" : installed ? "intact" : drifted ? "drifted" : missing ? "missing" : "inactive", repairable: missing && !drifted, contributions };
}
/** Explicit portable OpenCode commands also update the existing neutral override. */
export async function withNativeAdapterUpdate(root, enabled, dryRun, operation) {
    const update = async () => {
        const file = path.join(path.resolve(root), ".autoskill", "config.json"), before = await readSafeFile(file);
        if (before === undefined)
            return { result: await operation() };
        const config = await readPortableConfig(root), after = edit(before, ["adapters", "opencode"], { ...(config.adapters.opencode ?? {}), enabled });
        const changed = before !== after;
        if (!dryRun && changed)
            await writeSafeFile(file, after, sha256(before));
        try {
            const result = await operation();
            return { result, neutralAdapter: { changed, enabled, dryRun } };
        }
        catch (error) {
            if (!dryRun && changed && await readSafeFile(file) === after)
                await writeSafeFile(file, before, sha256(after));
            throw error;
        }
    };
    return dryRun ? update() : withPortableLock(root, "configuration", update);
}
/** Apply only owned leaf fields/array entries; unrelated host configuration survives uninstall. */
export async function installHost(input) {
    if (input.dryRun || input.host === "opencode")
        return installHostUnlocked(input);
    return withPortableLock(input.root, "configuration", () => installHostUnlocked(input));
}
async function installHostUnlocked(input) {
    const root = path.resolve(input.root), host = normalizeHost(input.host), action = input.action ?? "install";
    if (host === "opencode")
        return { host, status: "delegate", action, reason: "Use the OpenCode native installer." };
    const configFile = path.join(root, ".autoskill", "config.json"), configBefore = await readSafeFile(configFile);
    if (configBefore === undefined && await hasLegacyData(root))
        throw new Error("Legacy AutoSkill data exists. Run autoskill migrate before installing a portable adapter.");
    const config = await readPortableConfig(root);
    const { file: manifestFile, text: manifestText, manifest } = await readManifest(root, host);
    const emptyText = (relative) => relative.endsWith(".toml") ? "" : "{}\n";
    const files = new Map();
    const read = async (relative) => {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
            throw new Error("Installation path escapes project.");
        if (!files.has(relative)) {
            const before = await readSafeFile(path.join(root, relative));
            files.set(relative, { before, after: before ?? emptyText(relative) });
        }
        return files.get(relative);
    };
    const removing = action === "uninstall" || action === "disable";
    const repairs = [];
    // Remove the previous owned contribution first, then install the new definition.
    for (const change of manifest.changes) {
        const file = await read(change.file);
        const actual = inspectChange(change, file.before);
        if (actual.state === "missing") {
            if (!removing)
                repairs.push(actual);
            continue;
        }
        if (actual.state !== "present")
            throw new Error(`Managed configuration changed: ${change.file}; inspect doctor before retrying. No configuration was written.`);
        if (change.kind === "toml") {
            file.after = file.after.replace(change.installed, "");
        }
        else {
            if (!change.key || hashValue(change.installed) !== change.hash)
                throw new Error("Invalid owned configuration record.");
            const value = at(parseObject(file.after, change.file), change.key);
            if (change.kind === "array") {
                if (!Array.isArray(value) || !value.some(v => equal(v, change.installed)))
                    throw new Error(`Managed hook changed: ${change.file}`);
                const remaining = [...value];
                remaining.splice(remaining.findIndex(v => equal(v, change.installed)), 1);
                file.after = edit(file.after, change.key, remaining.length || change.beforePresent ? remaining : undefined);
            }
            else {
                if (!equal(value, change.installed))
                    throw new Error(`Managed configuration changed: ${change.file}`);
                file.after = edit(file.after, change.key, change.beforePresent ? change.before : undefined);
            }
        }
    }
    const changes = [];
    const add = async (fileName, key, installed, kind = "field") => {
        const file = await read(fileName), before = at(parseObject(file.after, fileName), key);
        if (kind === "field" && before !== undefined && !equal(before, installed))
            throw new Error(`Existing autoskill server conflicts in ${fileName}; no configuration was written.`);
        if (kind === "array" && before !== undefined && !Array.isArray(before))
            throw new Error(`Expected hook array in ${fileName}.`);
        file.after = edit(file.after, key, kind === "array" ? [...(before ?? []), installed] : installed);
        changes.push({ file: fileName, key, kind, installed, before, beforePresent: before !== undefined, hash: hashValue(installed) });
    };
    if (!removing) {
        const entry = packageEntry(input.packageDir);
        const entryStat = await fs.stat(entry).catch(error => { if (error.code === "ENOENT")
            return undefined; throw error; });
        if (!entryStat?.isFile())
            throw new Error(`AutoSkill package entry not found or not a regular file: ${entry}; no configuration was written.`);
        const server = { command: process.execPath, args: [entry, "serve", "--host", host, "--project", root] };
        if (host === "codex") {
            const name = ".codex/config.toml", file = await read(name);
            if (file.before === undefined)
                file.after = "";
            const existing = parseTomlConfig(file.after, name);
            if (ownedValue(existing, ["mcp_servers", "autoskill"]).value !== undefined)
                throw new Error("Existing Codex autoskill MCP configuration conflicts; no configuration was written.");
            const block = `\n# BEGIN AUTOSKILL MANAGED MCP\n[mcp_servers.autoskill]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(server.args)}\n# END AUTOSKILL MANAGED MCP\n`;
            file.after += block;
            try {
                parseTomlConfig(file.after, name);
            }
            catch {
                throw new Error("Existing Codex TOML structure cannot accept the managed MCP table; no configuration was written.");
            }
            changes.push({ file: name, kind: "toml", installed: block, hash: sha256(block) });
        }
        else {
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
                if (value.version === undefined)
                    await add(file, ["version"], 1);
            }
        }
    }
    const enabled = !removing;
    let configAfter = configBefore ?? JSON.stringify(config, null, 2) + "\n";
    configAfter = edit(configAfter, ["adapters", host], { ...(config.adapters[host] ?? {}), enabled, mode: host === "generic" ? "mcp" : "hooks" });
    const writes = [...files].filter(([name, file]) => file.before !== file.after && !(file.before === undefined && file.after === emptyText(name))).map(([file, value]) => ({ file, ...value }));
    for (const write of writes)
        if (write.file.endsWith(".toml"))
            parseTomlConfig(write.after, write.file);
    if (!input.dryRun) {
        await ensurePortablePrivate(root);
        const backupId = `${Date.now()}-${randomUUID()}`;
        for (const write of writes)
            if (write.before !== undefined)
                await writeSafeFile(path.join(root, ".autoskill", "config-backups", backupId, write.file), write.before, null);
        // Validate all CAS expectations before the first host mutation.
        for (const write of writes)
            if ((await readSafeFile(path.join(root, write.file))) !== write.before)
                throw new Error("Host configuration changed; retry installation.");
        const committed = [];
        let manifestCommitted = false;
        const manifestAfter = JSON.stringify({ schemaVersion: 1, host, changes }, null, 2) + "\n";
        try {
            for (const write of writes) {
                await writeSafeFile(path.join(root, write.file), write.after, write.before === undefined ? null : sha256(write.before));
                committed.push(write);
            }
            await writeSafeFile(manifestFile, manifestAfter, manifestText === undefined ? null : sha256(manifestText));
            manifestCommitted = true;
            await writeSafeFile(configFile, configAfter, configBefore === undefined ? null : sha256(configBefore));
        }
        catch (error) {
            if (manifestCommitted && await readSafeFile(manifestFile) === manifestAfter) {
                if (manifestText === undefined)
                    await fs.unlink(manifestFile);
                else
                    await writeSafeFile(manifestFile, manifestText, sha256(manifestAfter));
            }
            for (const write of committed.reverse()) {
                const file = path.join(root, write.file);
                if (await readSafeFile(file) === write.after) {
                    if (write.before === undefined)
                        await fs.unlink(file);
                    else
                        await writeSafeFile(file, write.before, sha256(write.after));
                }
            }
            throw error;
        }
    }
    const phase = input.dryRun ? "preview" : !enabled ? "disabled" : config.options.enabled === false ? "globally-disabled" : host === "generic" ? "tools-only" : !config.reviewer ? "needs-reviewer" : config.reviewer.apiKeyEnv && !process.env[config.reviewer.apiKeyEnv] ? "needs-reviewer-credential" : "awaiting-host";
    const messages = { preview: "安装配置变更已准备好，可查看文件与修复计划。", disabled: action === "uninstall" ? "接入配置已卸载。" : "适配器已停用。", "globally-disabled": "接入配置已写入；AutoSkill 总开关处于停用状态。", "tools-only": "技能检索与加载入口已配置；通用 MCP 不提供自动采集与提炼。", "needs-reviewer": "技能复用与任务采集已配置；自动复盘等待配置 reviewer。", "needs-reviewer-credential": "技能复用与任务采集已配置；自动复盘等待 reviewer 凭证。", "awaiting-host": "接入配置已写入，等待宿主信任配置并运行任务以验证 hooks。" };
    return { host, action, status: input.dryRun ? "dry-run" : "configured", enabled, files: writes.map(item => item.file), ...(repairs.length ? { repairs } : {}), summary: { phase, message: messages[phase], ...(["needs-reviewer", "needs-reviewer-credential"].includes(phase) ? { nextAction: "在 .autoskill/config.json 配置 reviewer，并在启动宿主的环境中提供 apiKeyEnv 对应变量。" } : {}) }, needsHostTrust: enabled && host !== "generic", verification: "configuration-written; host execution not verified" };
}
//# sourceMappingURL=install.js.map