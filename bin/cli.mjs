import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parse, parseTree, findNodeAtLocation, createScanner, SyntaxKind, modify, applyEdits } from "jsonc-parser";

const ownPackage = fileURLToPath(new URL("../", import.meta.url));
const ID = "opencode-autoskill";
const TESTED_VERSION = "2.2.7";
const CONFIG_COMMANDS = new Set(["install", "uninstall", "enable", "disable"]);
const SKILL_COMMANDS = new Set(["list", "inspect", "pin", "unpin", "archive", "rollback", "restore", "adopt", "feedback", "prune"]);
const DRAFT_COMMANDS = new Set(["list", "inspect", "publish", "discard"]);
const help = `OpenCode AutoSkill — 自动经验提炼插件

用法：
  opencode-autoskill install|uninstall|enable|disable [--project <目录>]
  opencode-autoskill status [--runtime] [--project <目录>]
  opencode-autoskill doctor [--opencode <可执行文件>] [--project <目录>]
  opencode-autoskill recover [--dry-run] [--project <目录>]
  opencode-autoskill clean [--older-than 30] [--dry-run] [--project <目录>]
  opencode-autoskill skills list|inspect [<id>] [--project <目录>]
  opencode-autoskill skills pin|unpin|archive|adopt <id> [--dry-run]
  opencode-autoskill skills rollback <id> [--version <版本>] [--dry-run]
  opencode-autoskill skills feedback <id> --outcome success|failure [--notes <说明>]
  opencode-autoskill skills prune [--keep 50] [--older-than <天数>] [--dry-run]
  opencode-autoskill drafts list|inspect [<id>] [--project <目录>]
  opencode-autoskill drafts publish|discard <id> [--dry-run] [--project <目录>]
  opencode-autoskill reuse status|history [<skillId>] [--project <目录>]
  opencode-autoskill reuse feedback <skillId> --session <id> --task <用户消息ID> --outcome success|failure|unknown
  opencode-autoskill reuse govern [--apply] [--dry-run] [--project <目录>]

选项：
  --project <目录>   目标项目，默认当前目录
  --global           选择用户 OpenCode 配置；不能与 --project 或 --config 混用
  --config <文件>    精确选择 opencode.json/jsonc；以该文件所在目录为作用域
  --package <目录>   插件包目录，默认当前安装包
  --replace <引用>   迁移无法自动识别的旧插件引用（如已删除的 v0.1 目录）
  --runtime          查看本地队列、最近筛选结果和恢复状态，无需模型
  --dry-run          预览修改，不写配置、不调用模型、不修改技能
  --opencode <路径>  doctor 使用指定 CLI；也可设置 OPENCODE_BIN
  --help, -h         显示帮助

配置备份位于用户私有状态目录，最多保留 10 份。AUTOSKILL_STATE_HOME 可覆盖目录。
默认自动提炼。手动预览提炼可在 OpenCode 调用 autoskill_review 并设置 dryRun=true。
`;

function parseArgs(args) {
  const options = {};
  const positional = [];
  const flags = new Set(["global", "runtime", "dry-run", "apply"]);
  const values = new Set(["project", "config", "package", "replace", "opencode", "version", "outcome", "notes", "keep", "older-than", "session", "task", "query-hash", "skill-hash"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { command: "help", options, positional: [] };
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const key = arg.replace(/^--/, "");
    if (flags.has(key)) { options[key] = true; continue; }
    if (!values.has(key)) throw new Error(`未知选项：${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 需要一个值。`);
    if (options[key] !== undefined) throw new Error(`重复选项：${arg}`);
    options[key] = value;
  }
  if (options.global && (options.project || options.config)) throw new Error("--global 不能与 --project 或 --config 同时使用。");
  let command = positional.shift() ?? "help";
  if (SKILL_COMMANDS.has(command)) { positional.unshift(command); command = "skills"; }
  if (!["help", "install", "uninstall", "status", "doctor", "enable", "disable", "recover", "clean", "skills", "drafts", "reuse"].includes(command)) throw new Error(`未知命令：${command}`);
  if (command === "skills" && !SKILL_COMMANDS.has(positional[0] ?? "list")) throw new Error(`未知技能命令：${positional[0]}`);
  if (command === "drafts" && !DRAFT_COMMANDS.has(positional[0] ?? "list")) throw new Error(`未知候选命令：${positional[0]}`);
  if (options.global && ["skills", "drafts", "reuse", "recover", "clean"].includes(command)) throw new Error(`${command} 操作项目数据，请使用 --project。`);
  if (!["skills", "drafts", "reuse"].includes(command) && positional.length) throw new Error(`多余参数：${positional.join(" ")}`);
  if (options.apply && (command !== "reuse" || positional[0] !== "govern")) throw new Error("--apply 仅用于 reuse govern。");
  if (options.replace && command !== "install" && command !== "uninstall") throw new Error("--replace 仅用于 install/uninstall。");
  return { command, options, positional };
}

async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function regular(file, maxBytes = 2_000_000) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("路径必须是大小受限的普通文件，不能是符号链接。");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function safeDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("拒绝通过符号链接或非目录路径写入配置/备份。");
  }
  return absolute;
}

async function atomicFile(file, content) {
  await safeDirectory(path.dirname(file));
  await regular(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await regular(file);
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

function parseConfig(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是有效的 JSON/JSONC 对象。未写入任何修改。");
  if (value.plugins !== undefined && !Array.isArray(value.plugins)) throw new Error("配置的 plugins 必须是数组。未写入任何修改。");
  return value;
}

function samePath(left, right) {
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function localReference(reference, base) {
  if (typeof reference !== "string") return undefined;
  if (reference.startsWith("file:")) { try { return path.resolve(fileURLToPath(reference)); } catch { return undefined; } }
  if (path.isAbsolute(reference) || reference.startsWith(".")) return path.resolve(base, reference);
  return undefined;
}

function stateHome() {
  return path.resolve(process.env.AUTOSKILL_STATE_HOME ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), ID));
}

function globalConfigRoot() {
  return path.resolve(process.env.AUTOSKILL_CONFIG_HOME ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "opencode"));
}

async function resolveTarget(options) {
  let root = options.global ? globalConfigRoot() : path.resolve(options.project ?? process.cwd());
  let configPath;
  if (options.config) {
    configPath = path.resolve(options.config);
    if (!["opencode.json", "opencode.jsonc"].includes(path.basename(configPath))) throw new Error("--config 必须指向 opencode.json 或 opencode.jsonc。");
    if (options.project && !samePath(root, path.dirname(configPath))) throw new Error("--project 与 --config 必须选择同一项目目录。");
    root = path.dirname(configPath);
  } else {
    const json = path.join(root, "opencode.json");
    const jsonc = path.join(root, "opencode.jsonc");
    const [hasJson, hasJsonc] = await Promise.all([exists(json), exists(jsonc)]);
    if (hasJson && hasJsonc) throw new Error("同时存在 opencode.json 和 opencode.jsonc；请用 --config 指定。");
    configPath = hasJson ? json : jsonc;
  }
  const configId = createHash("sha256").update(process.platform === "win32" ? configPath.toLowerCase() : configPath).digest("hex");
  const privateRoot = stateHome();
  return { root, configPath, packageDir: path.resolve(options.package ?? ownPackage), privateRoot,
    backupRoot: path.join(privateRoot, "config-backups", configId), manifestPath: path.join(privateRoot, "installations", `${configId}.json`), scope: options.global ? "global" : "project" };
}

async function readTarget(target) {
  if (!await regular(target.configPath)) return { present: false, text: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n', value: {} };
  const text = await fs.readFile(target.configPath, "utf8");
  return { present: true, text, value: parseConfig(text) };
}

async function manifest(target) {
  if (!await regular(target.manifestPath, 64_000)) return { schemaVersion: 1, id: ID, references: [] };
  try {
    const value = JSON.parse(await fs.readFile(target.manifestPath, "utf8"));
    if (value.id !== ID || !Array.isArray(value.references)) throw new Error();
    return { ...value, references: value.references.filter(value => typeof value === "string").slice(-100) };
  } catch { throw new Error("安装身份记录损坏；请先检查私有状态目录中的 installations 文件。"); }
}

async function matchesPlugin(entry, target, identity, replacement) {
  const reference = typeof entry === "string" ? entry : entry?.package;
  if (typeof reference !== "string") return false;
  const local = localReference(reference, path.dirname(target.configPath));
  if (replacement && (reference === replacement || local && samePath(local, path.resolve(replacement)))) return true;
  if (/^(?:npm:)?opencode-autoskill(?:@[^/]+)?$/.test(reference)) return true;
  if (!local) return false;
  if (samePath(local, target.packageDir) || identity.references.some(value => {
    const old = localReference(value, path.dirname(target.configPath));
    return old && samePath(old, local);
  })) return true;
  const packageFile = path.join(local, "package.json");
  if (!await regular(packageFile, 64_000)) return false;
  try { return JSON.parse(await fs.readFile(packageFile, "utf8")).name === ID; } catch { return false; }
}

async function preparePrivate(target) {
  const relative = path.relative(target.privateRoot, target.root);
  if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("AUTOSKILL_STATE_HOME 必须是独立状态目录，不能覆盖项目或配置目录。");
  }
  await safeDirectory(target.privateRoot);
  const ignore = path.join(target.privateRoot, ".gitignore");
  const previous = await regular(ignore) ? await fs.readFile(ignore, "utf8") : "";
  if (previous.trimEnd().split(/\r?\n/).at(-1) !== "*") await atomicFile(ignore, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}*\n`);
}

async function writeManifest(target, identity, references) {
  await preparePrivate(target);
  await atomicFile(target.manifestPath, JSON.stringify({ schemaVersion: 1, id: ID, config: target.configPath,
    references: [...new Set([...identity.references, ...references])].slice(-100), updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

async function writeConfig(target, config, after) {
  const current = await readTarget(target);
  if (current.present !== config.present || current.present && current.text !== config.text) throw new Error("配置在操作期间被修改，请重试；未覆盖其他修改。");
  await preparePrivate(target);
  await safeDirectory(path.dirname(target.configPath));
  if (config.present) {
    await safeDirectory(target.backupRoot);
    const backup = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.bak`;
    await atomicFile(path.join(target.backupRoot, backup), config.text);
    const backups = (await fs.readdir(target.backupRoot)).filter(name => /^[0-9TZ-]+-[a-f0-9-]+\.bak$/i.test(name)).sort().reverse();
    for (const name of backups.slice(10)) {
      const file = path.join(target.backupRoot, name);
      if (await regular(file)) await fs.unlink(file);
    }
  }
  await atomicFile(target.configPath, after);
}

function jsonEdit(text, at, value) {
  // jsonc-parser's formatted array deletion can corrupt compact string arrays.
  // Remove the exact AST element and one adjacent comma; keep all other comments.
  if (value === undefined && at.length === 2 && at[0] === "plugins") {
    const array = findNodeAtLocation(parseTree(text), ["plugins"]);
    const index = at[1];
    const node = array?.children?.[index];
    if (!node) return text;
    const children = array.children;
    const edits = [{ offset: node.offset, length: node.length, content: "" }];
    const commaBetween = (start, end) => {
      const scanner = createScanner(text, false);
      scanner.setPosition(start);
      while (scanner.getPosition() < end) {
        const token = scanner.scan();
        if (token === SyntaxKind.CommaToken) return scanner.getTokenOffset();
        if (token === SyntaxKind.EOF) break;
      }
      return undefined;
    };
    const following = commaBetween(node.offset + node.length, index < children.length - 1 ? children[index + 1].offset : array.offset + array.length - 1);
    const comma = following ?? (index > 0 ? commaBetween(children[index - 1].offset + children[index - 1].length, node.offset) : undefined);
    if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" });
    return applyEdits(text, edits);
  }
  return applyEdits(text, modify(text, at, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
}

async function assertBuilt(packageDir) {
  if (!await regular(path.join(packageDir, "dist", "index.js"))) throw new Error(`插件包尚未构建：${packageDir}\n请先执行 npm ci 和 npm run build。`);
}

async function loadBuilt(file) {
  const full = path.join(ownPackage, "dist", file);
  if (!await regular(full)) throw new Error("插件包尚未构建，请先执行 npm run build。");
  return import(pathToFileURL(full).href);
}

async function storageLayout(root) {
  const { resolveStorageLayout } = await loadBuilt("storage-layout.js");
  return resolveStorageLayout(root);
}

function summarizeRuntime(state) {
  const jobs = Array.isArray(state.jobs) ? state.jobs : Object.values(state.jobs ?? {});
  const counts = {};
  for (const job of jobs) counts[job.status ?? "unknown"] = (counts[job.status ?? "unknown"] ?? 0) + 1;
  const resultSummary = result => ({ status: result?.status, reason: result?.reason, skillId: result?.skillId,
    reasonCode: result?.reasonCode, taskId: result?.taskId, nextRunAt: result?.nextRunAt });
  const recent = Array.isArray(state.recent) ? state.recent.slice(-20).map(item => ({ at: item.at, sessionId: item.sessionId, jobId: item.jobId,
    ...resultSummary(item.result ?? item), reasonCode: item.reasonCode ?? item.result?.reasonCode })) : [];
  const lastDecision = state.lastDecision ? { at: state.lastDecision.at, sessionId: state.lastDecision.sessionId,
    jobId: state.lastDecision.jobId, reasonCode: state.lastDecision.reasonCode, result: resultSummary(state.lastDecision.result) } : null;
  return { status: "available", version: state.version ?? state.schemaVersion, day: state.day,
    reviews: state.reviews, budget: state.budget ?? { day: state.day, reviews: state.reviews, estimatedInputTokens: state.inputTokens ?? 0 },
    lastEventAt: state.lastEventAt ?? state.lastSeenAt, lastRecoveryAt: state.lastRecoveryAt,
    capabilities: state.capabilities ?? null, reuseCapabilities: state.reuseCapabilities ?? null, lastDecision, metrics: state.metrics ?? {}, queue: counts,
    jobs: jobs.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)).slice(0, 30).map(job => ({ id: job.id, sessionId: job.sessionId, hostId: job.hostId, workspaceId: job.workspaceId, status: job.status, attempts: job.attempts,
      nextRunAt: job.nextRunAt, reasonCode: job.reasonCode ?? job.result?.reasonCode, reason: job.reason ?? job.result?.reason ?? job.lastResult?.reason,
      preScreen: job.preScreen ? { eligible: job.preScreen.eligible, version: job.preScreen.version, score: job.preScreen.score,
        threshold: job.preScreen.threshold, dimensions: job.preScreen.dimensions, reasonCodes: job.preScreen.reasonCodes } : undefined })), recent };
}

async function queueStore(root) {
  const { QueueStore } = await loadBuilt("jobs.js");
  if (!QueueStore) throw new Error("缺少队列运行模块，请重新构建插件包。");
  return new QueueStore(root);
}

async function runtimeState(root) {
  const directory = (await storageLayout(root)).stateRoot;
  const database = path.join(directory, "runtime.sqlite");
  const legacy = path.join(directory, "state.json");
  const reuse = await reuseRuntime(root);
  if (!await exists(database) && !await exists(legacy)) return { status: "not-started", queue: {}, recent: [], ...(reuse ? { reuse } : {}) };
  if (await exists(database)) {
    const store = await queueStore(root);
    try { return { ...summarizeRuntime(await store.read()), ...(reuse ? { reuse } : {}) }; } finally { await store.close?.(); }
  }
  if (!await regular(legacy)) return { status: "not-started", queue: {}, recent: [] };
  return { ...summarizeRuntime(JSON.parse(await fs.readFile(legacy, "utf8"))), source: "legacy-state" };
}

async function reuseRuntime(root) {
  if (!await regular(path.join((await storageLayout(root)).stateRoot, "reuse.sqlite"), 100_000_000)) return undefined;
  const { ReuseStore } = await loadBuilt("reuse-store.js");
  const ledger = new ReuseStore(root);
  try { return { ...await ledger.status(), history: (await ledger.history()).slice(0, 100) }; } finally { await ledger.close(); }
}

async function reuseCommand(root, positional, options) {
  const [command = "status", skillId, extra] = positional;
  if (extra || !["status", "history", "feedback", "govern"].includes(command)) throw new Error("reuse 用法：status、history [skillId]、feedback <skillId> 或 govern。");
  if (["status", "govern"].includes(command) && skillId) throw new Error(`reuse ${command} 不接受技能 ID。`);
  if (command === "status") return await reuseRuntime(root) ?? { status: "not-started", searchedTasks: 0, loadedTasks: 0, reportedUsedTasks: 0, recent: [] };
  const { ReuseStore } = await loadBuilt("reuse-store.js");
  const ledgerFile = path.join((await storageLayout(root)).stateRoot, "reuse.sqlite");
  const present = await regular(ledgerFile, 100_000_000);
  if (command === "history" && !present) return { history: [] };
  if (command === "feedback" && !present) throw new Error("没有可反馈的已加载技能记录。");
  const ledger = new ReuseStore(root);
  try {
    if (command === "history") return { history: await ledger.history(skillId) };
    if (command === "govern") {
      const { SkillStore } = await loadBuilt("skills.js");
      const { planReuseGovernance, applyReuseGovernance } = await loadBuilt("reuse-governance.js");
      const skills = await new SkillStore(root).list();
      const stats = present ? await ledger.history() : [];
      const scoped = new Map(stats.map((item) => [`${item.skillId}:${item.sha256}`, item]));
      // The legacy skills feedback command is user-authored too. Merge it only
      // when no task-scoped ledger feedback exists for this exact skill hash.
      for (const skill of skills) {
        const hash = skill.sha256; if (!hash) continue;
        const key = `${skill.id}:${hash}`; if (scoped.has(key)) continue;
        const feedback = skill.versionFeedback ?? { success: 0, failure: 0 };
        if (feedback.success || feedback.failure) scoped.set(key, { skillId: skill.id, sha256: hash, offered: 0, loaded: 0, nativeLoaded: 0, reportedUsed: 0,
          feedback: { success: feedback.success, failure: feedback.failure, unknown: 0 }, userFeedback: feedback, modelFeedback: { success: 0, failure: 0 }, taskOutcomes: { success: 0, failure: 0, interrupted: 0, unknown: 0 } });
      }
      const plan = planReuseGovernance(skills, [...scoped.values()]);
      const dryRun = !options.apply || options["dry-run"] === true;
      return { plan, ...await applyReuseGovernance(root, plan, { dryRun }) };
    }
    if (!skillId || !options.session || !options.task || !["success", "failure", "unknown"].includes(options.outcome)) throw new Error("reuse feedback 需要技能 ID、--session、--task、--outcome success|failure|unknown。");
    const identity = { sessionId: options.session, anchorId: options.task, queryHash: options["query-hash"] };
    const task = await ledger.getTask(identity);
    const matches = task?.skills.filter((skill) => skill.skillId === skillId && skill.loaded && (!options["skill-hash"] || skill.sha256 === options["skill-hash"])) ?? [];
    if (matches.length !== 1) throw new Error("任务没有唯一的已加载技能版本；请核对任务标识，必要时指定 --skill-hash。");
    const target = { ...identity, queryHash: task.queryHash, skillId, sha256: matches[0].sha256 };
    if (options["dry-run"]) return { dryRun: true, action: "reuse-feedback", source: "user", outcome: options.outcome, ...target };
    if (options.outcome !== "unknown") await ledger.recordUse({ ...target, source: "user" });
    return { source: "user", task: await ledger.feedback({ ...target, source: "user", outcome: options.outcome }) };
  } finally { await ledger.close(); }
}

async function recoverRuntime(root, dryRun) {
  if (dryRun) return { dryRun: true, runtime: await runtimeState(root) };
  const store = await queueStore(root);
  try {
    const result = await store.recover();
    return { recovered: result.recovered, publications: result.publications.map(job => ({ id: job.id, sessionId: job.sessionId, status: job.status,
      skillId: job.publication?.skillId, reasonCode: job.reasonCode })) };
  } finally { await store.close?.(); }
}

async function moduleProbe(packageDir) {
  const script = `import {pathToFileURL} from 'node:url';import(pathToFileURL(process.argv[1]).href).then(m=>console.log(JSON.stringify({loaded:true,validDefinition:m.default?.id==='opencode-autoskill'&&typeof m.default?.setup==='function'}))).catch(()=>{console.log(JSON.stringify({loaded:false,validDefinition:false}));process.exitCode=1});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path.join(packageDir, "dist", "index.js")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  try { return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/).at(-1)); }
  catch { return { loaded: false, validDefinition: false, error: result.error?.code ?? "MODULE_LOAD_FAILED" }; }
}

async function otherScope(target, options) {
  if (options.global) return { inspected: false, reason: "Project is not selected in global scope." };
  const directory = globalConfigRoot();
  const installed = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(directory, name);
    if (!await regular(file)) continue;
    let value;
    try { value = parseConfig(await fs.readFile(file, "utf8")); } catch { continue; }
    const globalTarget = { ...target, configPath: file };
    for (const entry of value.plugins ?? []) if (await matchesPlugin(entry, globalTarget, { references: [] })) installed.push(name);
  }
  return { inspected: true, globalInstalled: installed.length > 0, configurations: installed,
    note: installed.length ? "全局也配置了 AutoSkill，请检查宿主有效插件列表，避免重复启用。" : undefined };
}

async function skillCommand(root, positional, options) {
  const [command = "list", id, extra] = positional;
  if (positional.length > 3) throw new Error("技能命令参数过多。");
  const { SkillStore } = await loadBuilt("skills.js");
  const store = new SkillStore(root);
  if (command === "list") {
    if (id) throw new Error("skills list 不接受技能 ID。");
    return { skills: (await store.list()).map(skill => ({ id: skill.id, name: skill.name, title: skill.title, description: skill.description,
      ownership: skill.ownership, pinned: skill.pinned, archived: skill.archived, version: skill.version,
      usageCount: skill.usageCount, lastUsedAt: skill.lastUsedAt, feedback: skill.feedback })) };
  }
  if (command === "prune") {
    if (id) throw new Error("skills prune 请通过 --keep/--older-than 筛选。");
    const keep = options.keep === undefined ? 50 : Number(options.keep);
    const days = options["older-than"] === undefined ? undefined : Number(options["older-than"]);
    if (!Number.isInteger(keep) || keep < 0 || keep > 100_000 || days !== undefined && (!Number.isFinite(days) || days < 0)) throw new Error("--keep 须为非负整数；--older-than 须为非负天数。");
    const skills = (await store.list()).filter(skill => (skill.ownership === "managed" || !skill.ownership && skill.managed) && !skill.archived && !skill.pinned);
    const dated = await Promise.all(skills.map(async skill => ({ skill, time: skill.lastUsedAt ? Date.parse(skill.lastUsedAt) : (await fs.stat(skill.path)).mtimeMs })));
    dated.sort((a, b) => b.time - a.time);
    const candidates = dated.slice(keep).filter(item => !item.skill.pinned && (days === undefined || Date.now() - item.time >= days * 86_400_000)).map(item => item.skill.id);
    if (!options["dry-run"]) for (const candidate of candidates) await store.archive(candidate);
    return { action: "prune", dryRun: !!options["dry-run"], keep, olderThanDays: days, archived: candidates };
  }
  if (!id) throw new Error(`skills ${command} 需要技能 ID。`);
  if (extra && !["rollback", "restore", "feedback"].includes(command)) throw new Error(`skills ${command} 参数过多。`);
  const outcome = options.outcome ?? extra;
  if (command === "feedback" && !["success", "failure"].includes(outcome)) throw new Error("feedback 需要 --outcome success 或 failure。");
  if (command === "inspect") return store.inspect(id);
  const before = await store.inspect(id);
  if (options["dry-run"]) return { dryRun: true, action: command, id, current: before.skill, version: options.version ?? extra };
  if (command === "pin" || command === "unpin") return { action: command, skill: await store.pin(id, command === "pin") };
  if (command === "archive") return { action: command, skill: await store.archive(id) };
  if (command === "adopt") return { action: command, skill: await store.adopt(id) };
  if (command === "rollback" || command === "restore") return { action: command, skill: await store.restore(id, options.version ?? extra) };
  if (command === "feedback") {
    return { action: command, skill: await store.feedback(id, { outcome, notes: options.notes }) };
  }
  throw new Error(`未知技能命令：${command}`);
}

async function draftCommand(root, positional, options) {
  const [command = "list", id] = positional;
  if (positional.length > 2) throw new Error("候选命令参数过多。");
  const { DraftStore } = await loadBuilt("drafts.js");
  const store = new DraftStore(root);
  if (command === "list") {
    if (id) throw new Error("drafts list 不接受候选 ID。");
    return { drafts: await store.list() };
  }
  if (!id) throw new Error(`drafts ${command} 需要候选 ID。`);
  if (command === "inspect") return store.inspect(id);
  if (options["dry-run"]) return { dryRun: true, action: command, id, draft: await store.inspect(id) };
  if (command === "publish") return { action: command, result: await store.publish(id) };
  if (command === "discard") return { action: command, result: await store.discard(id) };
  throw new Error(`未知候选命令：${command}`);
}

export async function runCli(args, io = { out: console.log, error: console.error }) {
  const { command, options, positional } = parseArgs(args);
  if (command === "help") { io.out(help); return 0; }
  const target = await resolveTarget(options);
  if (command === "skills") { io.out(JSON.stringify(await skillCommand(target.root, positional, options), null, 2)); return 0; }
  if (command === "drafts") { io.out(JSON.stringify(await draftCommand(target.root, positional, options), null, 2)); return 0; }
  if (command === "reuse") { io.out(JSON.stringify(await reuseCommand(target.root, positional, options), null, 2)); return 0; }
  if (command === "recover") { io.out(JSON.stringify(await recoverRuntime(target.root, !!options["dry-run"]), null, 2)); return 0; }
  if (command === "clean") {
    const olderThanDays = options["older-than"] === undefined ? 30 : Number(options["older-than"]);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error("--older-than 须为非负天数。");
    const { cleanEvidence } = await loadBuilt("maintenance.js");
    io.out(JSON.stringify(await cleanEvidence(target.root, { olderThanDays, dryRun: !!options["dry-run"] }), null, 2)); return 0;
  }
  const config = await readTarget(target);
  const plugins = config.value.plugins ?? [];
  const identity = await manifest(target);
  const matches = [];
  for (let index = 0; index < plugins.length; index++) if (await matchesPlugin(plugins[index], target, identity, options.replace)) matches.push(index);
  const enabled = matches.some(index => typeof plugins[index] !== "object" || plugins[index]?.options?.enabled !== false);
  if (command === "status") {
    io.out(JSON.stringify({ config: target.configPath, scope: target.scope, package: target.packageDir, installed: !!matches.length, enabled,
      matchingEntries: matches.length, migrationNeeded: matches.length > 1 || matches.some(index => (typeof plugins[index] === "string" ? plugins[index] : plugins[index].package) !== target.packageDir.replaceAll("\\", "/")),
      ...(options.runtime ? { runtime: await runtimeState(target.root) } : {}) }, null, 2));
    return 0;
  }
  if (command === "doctor") {
    const executable = options.opencode ?? process.env.OPENCODE_BIN ?? (process.platform === "win32" ? "opencode.exe" : "opencode");
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const match = (result.stdout ?? "").match(/\bv?(\d+\.\d+\.\d+)\b/);
    const version = result.status === 0 ? match?.[1] : undefined;
    const supported = version === TESTED_VERSION;
    const built = await regular(path.join(target.packageDir, "dist", "index.js"));
    const probe = built ? await moduleProbe(target.packageDir) : { loaded: false, validDefinition: false };
    const ownOptions = matches.length ? typeof plugins[matches[0]] === "object" ? plugins[matches[0]].options ?? {} : {} : {};
    let effectiveOptions; let optionsError;
    try {
      effectiveOptions = (await loadBuilt("config.js")).readOptions(ownOptions);
      effectiveOptions.sensitivePatterns = effectiveOptions.sensitivePatterns.map(() => "[configured fragment]");
    }
    catch (error) { optionsError = error.message; }
    const runtime = await runtimeState(target.root);
    const brokenLocalReferences = [];
    for (const entry of plugins) {
      const reference = typeof entry === "string" ? entry : entry?.package;
      const local = localReference(reference, path.dirname(target.configPath));
      if (local && !await exists(local)) brokenLocalReferences.push(reference);
    }
    const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
    const nodeSupported = nodeMajor > 22 || nodeMajor === 22 && nodeMinor >= 18;
    const configuredReferenceBroken = matches.some(index => brokenLocalReferences.includes(typeof plugins[index] === "string" ? plugins[index] : plugins[index].package));
    const ready = !!matches.length && matches.length === 1 && built && supported && nodeSupported && probe.validDefinition && !optionsError && !configuredReferenceBroken;
    io.out(JSON.stringify({ config: target.configPath, scope: target.scope, installed: !!matches.length, enabled, matchingEntries: matches.length,
      built, module: probe, opencodeVersion: version ?? "unavailable", testedVersion: TESTED_VERSION, supported,
      nodeVersion: process.versions.node, nodeSupported, configurationReady: ready,
      hostActivation: runtime.capabilities ? "observed" : "not-observed", capabilities: runtime.capabilities ?? null,
      effectiveOptions, optionsError, brokenLocalReferences, otherScope: await otherScope(target, options), runtime,
      note: supported ? "已检测到已测试 CLI 版本。模块导入不等同于宿主激活；能力状态以实际运行记录为准。" : "当前 CLI 未匹配已测试版本；不会仅凭主版本号认定兼容。" }, null, 2));
    return ready && runtime.capabilities?.supported !== false ? 0 : 1;
  }
  if (!CONFIG_COMMANDS.has(command)) throw new Error(`未知命令：${command}`);
  let after = config.text;
  const references = matches.map(index => typeof plugins[index] === "string" ? plugins[index] : plugins[index].package);
  let action = command;
  if (command === "install") {
    await assertBuilt(target.packageDir);
    const existing = matches.length ? plugins[matches[0]] : undefined;
    const entry = { ...(existing && typeof existing === "object" ? existing : {}), package: target.packageDir.replaceAll("\\", "/"),
      options: { enabled: true, ...(existing && typeof existing === "object" ? existing.options ?? {} : {}) } };
    if (matches.length) {
      after = jsonEdit(after, ["plugins", matches[0]], entry);
      for (const index of matches.slice(1).reverse()) after = jsonEdit(after, ["plugins", index], undefined);
      action = references.length === 1 && references[0] === entry.package ? "installed" : "migrated";
    } else after = config.value.plugins === undefined ? jsonEdit(after, ["plugins"], [entry]) : jsonEdit(after, ["plugins", plugins.length], entry);
    references.push(entry.package);
  } else if (command === "uninstall") {
    for (const index of [...matches].reverse()) after = jsonEdit(after, ["plugins", index], undefined);
  } else {
    if (!matches.length) throw new Error("尚未安装 AutoSkill，请先执行 install。");
    for (const index of matches) {
      const entry = typeof plugins[index] === "string" ? { package: plugins[index], options: {} } : plugins[index];
      after = jsonEdit(after, ["plugins", index], { ...entry, options: { ...entry.options, enabled: command === "enable" } });
    }
  }
  parseConfig(after);
  const changed = after !== config.text;
  if (options["dry-run"]) {
    io.out(JSON.stringify({ dryRun: true, action, changed, config: target.configPath, scope: target.scope, matchingEntries: matches.length,
      package: target.packageDir, backupDirectory: target.backupRoot }, null, 2));
    return 0;
  }
  if (changed) await writeConfig(target, config, after);
  if (command === "install") await writeManifest(target, identity, references);
  io.out(JSON.stringify({ action, changed, config: target.configPath, scope: target.scope, installed: command !== "uninstall" && (command === "install" || !!matches.length),
    enabled: command === "disable" || command === "uninstall" ? false : command === "enable" ? true : enabled || !matches.length,
    note: "重新加载 OpenCode 后生效。已生成的 Skills 与私有运行记录保留。" }, null, 2));
  return 0;
}
