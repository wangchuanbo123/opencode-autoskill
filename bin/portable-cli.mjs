import path from "node:path";
import { installHost, normalizeHost, portableHosts, readPortableConfig, withNativeAdapterUpdate } from "../dist/portable/install.js";
import { migrateProject } from "../dist/portable/migration.js";
import { syncNativeSkills } from "../dist/portable/sync.js";
import { doctorHost } from "../dist/portable/doctor.js";

const help = `AutoSkill portable adapters

  autoskill install|uninstall|enable|disable --host <opencode|claude-code|codex|gemini|cursor|generic> [--project <dir>]
  autoskill install|uninstall|enable|disable --all [--project <dir>]
  autoskill migrate [--rollback] [--dry-run] [--project <dir>]
  autoskill sync --host <host> [--prune] [--dry-run] [--project <dir>]
  autoskill doctor --host <host> [--binary <path>] [--project <dir>]
  autoskill status|worker --host <host> [--project <dir>]
  autoskill review --host <host> --context-token <token> [--dry-run] [--project <dir>]
  autoskill serve --host <host> [--project <dir>]
  autoskill hook --host <host> --event <event> [--project <dir>]

Migration preserves legacy files and refuses active queues. Stop every host first.
--dry-run previews installer, migration and sync operations without writing files.
--human prints concise management summaries instead of the default JSON.
--human is unavailable for hook/serve protocol commands.
Host configuration does not establish that hooks are trusted or executing.
`;
function parse(args) {
  const values = new Set(["host", "project", "event", "binary", "package", "opencode", "context-token"]), flags = new Set(["all", "dry-run", "prune", "rollback", "help", "human"]);
  const options = {}, positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (arg === "-h") { options.help = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2); if (options[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
    if (flags.has(key)) { options[key] = true; continue; }
    if (!values.has(key)) throw new Error(`Unknown portable option: ${arg}`);
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`); options[key] = value;
  }
  const command = positional.shift() ?? "help";
  if (positional.length) throw new Error(`Unexpected arguments: ${positional.join(" ")}`);
  if (options.all && options.host) throw new Error("--all and --host cannot be combined.");
  if (options.all && !["install", "uninstall", "enable", "disable", "doctor", "sync"].includes(command)) throw new Error("--all is not supported for this command.");
  if (options["dry-run"] && !["install", "uninstall", "enable", "disable", "migrate", "sync", "review"].includes(command)) throw new Error("--dry-run is not supported for this command.");
  if (options.human && ["hook", "serve"].includes(command)) throw new Error("--human is not supported for hook/serve protocol commands.");
  return { command: options.help ? "help" : command, options };
}
const phaseMessages = {
  unavailable: "运行状态暂时不可用，请检查本地配置或稍后重试。",
  disabled: "AutoSkill 已停用。", "tools-only": "MCP 技能检索与加载可用；通用 MCP 不提供自动采集与提炼。",
  "reuse-only": "技能复用与任务采集可用，自动复盘等待 reviewer。", reviewing: "正在复盘已采集的任务。",
  queued: "任务已排队，等待处理或重试时间。", "awaiting-host": "等待宿主信任配置并运行任务以验证 hooks。", ready: "已观测到宿主 hooks，当前没有待复盘任务。",
};
const statusMessages = { "dry-run": "变更预览", configured: "配置操作完成", synced: "原生技能同步完成", migrated: "迁移完成", "rolled-back": "迁移已回退", unavailable: "当前不可用", idle: "队列已空", busy: "已有处理进程在工作", queued: "任务已排队", saved: "技能已保存", skipped: "本轮未生成技能", failed: "处理失败", draft: "候选已保留，等待检查", cancelled: "任务已取消", disabled: "AutoSkill 已停用", "not-started": "尚无运行记录" };
const reasonMessages = { model_backend_unconfigured: "请在 .autoskill/config.json 配置 reviewer。", model_credential_missing: "请在启动宿主的环境中提供 reviewer.apiKeyEnv 对应的凭证。", trusted_completed_evidence_required: "需要已完成的真实宿主任务证据。", worker_time_slice_completed: "本次后台处理时间片已结束，余下任务将在下次启动时恢复。" };
function humanOutput(value, command, fallbackHost) {
  if (Array.isArray(value)) return value.map(item => humanOutput(item, command, fallbackHost)).join("\n\n");
  if (!value || typeof value !== "object") return String(value ?? "操作完成");
  const lines = [`AutoSkill${value.host || fallbackHost ? ` · ${value.host ?? fallbackHost}` : ""} · ${command}`];
  if (value.failures) {
    lines.push(value.phase === "preflight" ? "预检失败，尚未修改任何宿主配置。" : `执行中断，已有 ${value.summary?.succeeded ?? 0} 个平台完成。`);
    for (const failure of value.failures) lines.push(`${failure.host}：${failure.error}`);
    if (value.pending?.length) lines.push(`尚未处理：${value.pending.join("、")}`);
    return lines.join("\n");
  }
  if (value.result) return humanOutput(value.result, command, value.host);
  if (command === "doctor") {
    const configuration = value.configuration?.state === "drifted" ? "内容漂移，需要检查人工改动" : value.configuration?.state === "inactive" ? "受管配置已停用或卸载" : value.installed ? "受管配置完整" : value.installationRecorded ? "存在安装记录，实际配置缺失" : "未发现安装配置";
    lines.push(`配置：${configuration}；启用：${value.enabled ? "是" : "否"}。`);
    lines.push(`宿主事件：${value.observed ? "已观测" : "尚未观测"}；客户端验收：${value.verified ? "已验证" : "未验证"}。`);
    for (const item of value.configuration?.contributions ?? []) if (item.state !== "present") lines.push(`${item.file}${item.key ? ` · ${item.key.join(".")}` : ""}：${({ missing: "缺失", modified: "已修改，保留人工内容", invalid: "格式无效" })[item.state] ?? item.state}`);
    const projectArg = `'${String(value.root).replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
    if (value.repair) lines.push(`修复预览：autoskill install --host ${value.host} --project ${projectArg} --dry-run`, "检查预览后移除 --dry-run 可恢复缺失配置。");
    if (value.host === "generic") lines.push("通用 MCP 提供技能检索与加载，不提供自动采集与提炼。");
    else if (value.reviewer?.configured === false) lines.push("自动复盘：等待 reviewer；请配置 .autoskill/config.json 中的 reviewer。");
    else if (value.reviewer?.credentialAvailable === false) lines.push("自动复盘：等待 reviewer 凭证，请检查启动宿主的环境变量。");
  } else if (value.summary?.message) lines.push(phaseMessages[value.summary.phase] ?? value.summary.message);
  else if (value.status) lines.push(statusMessages[value.status] ?? `状态：${value.status}`);
  else if (value.installed !== undefined) lines.push(`配置：${value.installed ? "已安装" : "未安装"}；启用：${value.enabled ? "是" : "否"}。`);
  if (value.summary?.skillCount !== undefined) lines.push(`技能 ${value.summary.skillCount} 个；待复盘 ${value.summary.queuedReviews ?? 0} 项；待采集 ${value.summary.pendingEvidence ?? 0} 项。`);
  if (value.summary?.nextAction) lines.push(["reuse-only"].includes(value.summary.phase) ? "下一步：在 .autoskill/config.json 配置 reviewer，并在启动宿主的环境中提供凭证。" : `下一步：${value.summary.nextAction}`);
  if (value.reasonCode) lines.push(reasonMessages[value.reasonCode] ?? value.reason ?? `原因：${value.reasonCode}`);
  if (value.skillId) lines.push(`技能：${value.skillId}`);
  const nextRunAt = value.nextRunAt ?? value.summary?.nextRunAt;
  if (Number.isFinite(nextRunAt) && Math.abs(nextRunAt) <= 8.64e15) lines.push(`下次处理：${new Date(nextRunAt).toISOString()}`);
  if (Array.isArray(value.files) && value.files.length) lines.push(`涉及文件：${value.files.map(file => typeof file === "string" ? file : file.target ?? file.file ?? file.source).join("、")}`);
  if (value.repairs?.length) lines.push(`可恢复的缺失配置：${value.repairs.length} 项。`);
  if (command === "sync") lines.push(`导出 ${value.exported?.length ?? 0} 个；清理 ${value.pruned?.length ?? 0} 个；撤回 ${value.revoked?.length ?? 0} 个；冲突 ${value.conflicts?.length ?? 0} 个。`);
  if (command === "sync" && value.conflicts?.length) for (const conflict of value.conflicts) lines.push(`冲突：${typeof conflict === "string" ? conflict : conflict.id ?? conflict.file ?? conflict.reason}`);
  if (command === "config") lines.push(`已配置平台：${Object.entries(value.adapters ?? {}).map(([host, adapter]) => `${host}（${adapter.enabled ? "启用" : "停用"}）`).join("、") || "无"}。`, `复盘模型：${value.reviewer?.model ?? "未配置"}。`);
  return lines.join("\n");
}
export async function runPortableCli(args, io = { out: value => process.stdout.write(String(value) + "\n"), error: value => process.stderr.write(String(value) + "\n") }) {
  const { command, options } = parse(args), root = path.resolve(options.project ?? process.cwd()), dryRun = options["dry-run"] === true;
  const output = value => { if (value !== undefined) io.out(options.human ? humanOutput(value, command, options.host) : JSON.stringify(value, null, command === "hook" ? undefined : 2)); };
  if (command === "help") { io.out(help); return 0; }
  if (command === "migrate") { output(await migrateProject({ root, dryRun, rollback: options.rollback === true })); return 0; }
  if (options.rollback) throw new Error("--rollback is only valid for migrate.");
  if (options.prune && command !== "sync") throw new Error("--prune is only valid for sync.");
  const hosts = options.all ? portableHosts : [normalizeHost(options.host ?? "generic")];
  if (["install", "uninstall", "enable", "disable"].includes(command)) {
    const apply = async (host, preview) => {
      if (host === "opencode") {
        const { runCli } = await import("./cli.mjs");
        const native = [];
        const update = await withNativeAdapterUpdate(root, command === "install" || command === "enable", preview, async () => {
          const code = await runCli([command, "--project", root, ...(preview ? ["--dry-run"] : []), ...(options.package ? ["--package", options.package] : [])], { out: value => native.push(value), error: io.error });
          if (code !== 0) throw new Error("Native OpenCode configuration command failed."); return code;
        });
        return { host, result: native.map(value => { try { return JSON.parse(value); } catch { return value; } }), ...(update.neutralAdapter ? { neutralAdapter: update.neutralAdapter } : {}) };
      }
      return installHost({ root, host, action: command, dryRun: preview, packageDir: options.package });
    };
    if (options.all) {
      const previews = [], failures = [];
      for (const host of hosts) {
        try { previews.push(await apply(host, true)); }
        catch (error) { failures.push({ host, error: error.message }); }
      }
      if (failures.length) {
        output({ status: "preflight-failed", phase: "preflight", action: command, results: previews, failures, summary: { succeeded: 0, failed: failures.length, applied: 0 } });
        io.error(`AutoSkill: ${command} preflight failed for ${failures.map(failure => failure.host).join(", ")}; no host configuration was changed.`);
        return 1;
      }
      if (dryRun) { output(previews); return 0; }
    }
    const results = [];
    for (const host of hosts) {
      try { results.push(await apply(host, dryRun)); }
      catch (error) {
        if (!options.all) throw error;
        const pending = hosts.slice(results.length + 1);
        output({ status: results.length ? "partial-failure" : "failed", phase: "apply", action: command, results, failures: [{ host, error: error.message }], pending, summary: { succeeded: results.length, failed: 1, skipped: pending.length, applied: results.length } });
        io.error(`AutoSkill: ${command} failed for ${host} after ${results.length} host(s) completed; inspect the partial results before retrying.`);
        return 1;
      }
    }
    output(options.all ? results : results[0]); return 0;
  }
  if (command === "sync") { const results = []; for (const host of hosts) results.push(await syncNativeSkills({ root, host, dryRun, prune: options.prune === true })); output(options.all ? results : results[0]); return 0; }
  if (command === "doctor") { const results = []; for (const host of hosts) results.push(await doctorHost({ root, host, binary: options.binary ?? options.opencode })); output(options.all ? results : results[0]); return 0; }
  if (["hook", "serve", "worker", "review", "status"].includes(command)) {
    if (hosts[0] === "opencode") {
      if (command !== "status") throw new Error(`OpenCode ${command} uses the native plugin. Run autoskill_review inside the host, or select a portable host.`);
      const { runCli } = await import("./cli.mjs");
      if (!options.human) return runCli(["status", "--runtime", "--project", root], io);
      const native = [], code = await runCli(["status", "--runtime", "--project", root], { out: value => native.push(value), error: io.error });
      for (const value of native) { try { output(JSON.parse(value)); } catch { io.out(String(value)); } }
      return code;
    }
    if (command === "hook" && !options.event) throw new Error("hook requires --event.");
    if (command === "review" && !options["context-token"]) throw new Error("review requires --context-token from a completed trusted task.");
    const runtime = await import("../dist/portable/runtime.js");
    output(await runtime.runRuntimeCommand({ command, host: hosts[0], root, event: options.event, dryRun, ...(options["context-token"] ? { input: { contextToken: options["context-token"] } } : {}) })); return 0;
  }
  if (command === "config") { output(await readPortableConfig(root)); return 0; }
  throw new Error(`Unknown portable command: ${command}`);
}
