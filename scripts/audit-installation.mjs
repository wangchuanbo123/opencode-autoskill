#!/usr/bin/env node
/** Installation regression acceptance; every mutation is isolated in OS temp. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installHost } from "../dist/portable/install.js";
import { doctorHost } from "../dist/portable/doctor.js";
import { parse as parseToml } from "smol-toml";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-audit-installation-"));
const findings = [];
const scrub = value => String(value ?? "").replaceAll(fixture, "<fixture>");
const run = (binary, args, options = {}) => spawnSync(binary, args, {
  encoding: "utf8", windowsHide: true, timeout: 10_000, ...options,
});
const caseRoot = async name => { const root = path.join(fixture, name); await fs.mkdir(root); return root; };
const pythonProbe = ["python", "python3", "py"].map(binary => ({ binary, result: run(binary, ["-c", "import tomllib; print('tomllib available')"]) })).find(item => item.result.status === 0);
async function audit(id, operation) {
  try { findings.push({ id, ...await operation() }); }
  catch (error) { findings.push({ id, category: "verification-error", passed: false, error: scrub(error.message) }); }
}
try {
  await audit("relative-package-path", async () => {
    const root = await caseRoot("relative-package-path");
    await installHost({ root, host: "cursor", packageDir: "." });
    const config = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.autoskill;
    const launched = run(config.command, config.args, { cwd: root, input: "" });
    return {
      issue: "F08", category: "regression", severity: "P2", title: "Relative package entries resolve absolutely and launch from the target project",
      passed: path.isAbsolute(config.args[0]) && launched.status === 0,
      source: [{ file: "src/portable/install.ts" }],
      trigger: "install --host cursor --package . --project <a different project directory>",
      evidence: { entry: config.args[0], absolute: path.isAbsolute(config.args[0]), launchExit: launched.status,
        launchError: scrub(launched.stderr).split(/\r?\n/).find(line => line.includes("Cannot find module")) },
    };
  });
  await audit("doctor-missing-host-config", async () => {
    const root = await caseRoot("doctor-missing-host-config");
    await installHost({ root, host: "cursor" });
    await fs.unlink(path.join(root, ".cursor", "hooks.json"));
    await fs.unlink(path.join(root, ".cursor", "mcp.json"));
    const status = await doctorHost({ root, host: "cursor", binary: process.execPath });
    const preview = await installHost({ root, host: "cursor", dryRun: true });
    const repair = await installHost({ root, host: "cursor" });
    const repaired = await doctorHost({ root, host: "cursor", binary: process.execPath });
    return {
      issue: "F09", category: "regression", severity: "P2", title: "Doctor detects missing configuration and reinstall safely restores it",
      passed: status.installationRecorded === true && status.installed === false && status.enabled === false && status.configuration?.state === "missing" && preview.repairs?.length > 0 && repair.status === "configured" && repaired.installed === true,
      source: [{ file: "src/portable/doctor.ts" }, { file: "src/portable/install.ts" }],
      trigger: "Install Cursor, remove .cursor/hooks.json and .cursor/mcp.json, then run doctor --host cursor",
      evidence: { installed: status.installed, enabled: status.enabled, installationRecorded: status.installationRecorded, checks: status.checks, configuration: status.configuration, plannedRepairs: preview.repairs?.length, repairedInstalled: repaired.installed },
    };
  });
  await audit("codex-quoted-toml-table", async () => {
    const root = await caseRoot("codex-quoted-toml-table");
    await fs.mkdir(path.join(root, ".codex"));
    const file = path.join(root, ".codex", "config.toml");
    await fs.writeFile(file, '["mcp_servers"."autoskill"]\ncommand = "existing.exe"\n');
    const parse = () => pythonProbe ? run(pythonProbe.binary, ["-c", 'import tomllib,sys; tomllib.load(open(sys.argv[1], "rb"))', file]) : undefined;
    const original = await fs.readFile(file, "utf8"); parseToml(original);
    const before = parse();
    let installError;
    try { await installHost({ root, host: "codex" }); } catch (error) { installError = error.message; }
    const unchanged = await fs.readFile(file, "utf8") === original, after = parse();
    return {
      issue: "F02", category: "regression", severity: "P1", title: "Codex detects existing quoted TOML tables and preserves the valid configuration",
      passed: /conflicts/.test(installError ?? "") && unchanged && (!pythonProbe || before.status === 0 && after.status === 0),
      source: [{ file: "src/portable/install.ts" }],
      trigger: 'Existing valid .codex/config.toml contains ["mcp_servers"."autoskill"], then install --host codex',
      evidence: { parser: pythonProbe ? `${pythonProbe.binary}: tomllib` : "smol-toml (independent Python parser unavailable)", beforeParseExit: before?.status, installError, unchanged, afterParseExit: after?.status },
    };
  });
  await audit("batch-install-partial-feedback", async () => {
    const root = await caseRoot("batch-install-partial-feedback");
    await fs.mkdir(path.join(root, ".opencode", "skills", "manual"), { recursive: true });
    await fs.writeFile(path.join(root, ".opencode", "skills", "manual", "SKILL.md"), "# Manual skill\n");
    const result = run(process.execPath, [path.join(projectRoot, "bin", "autoskill.mjs"), "install", "--all", "--project", root], {
      cwd: projectRoot, env: { ...process.env, AUTOSKILL_STATE_HOME: path.join(fixture, "private-state") },
    });
    let nativeConfig;
    try { nativeConfig = await fs.readFile(path.join(root, "opencode.jsonc"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return {
      category: "regression", severity: "P2", title: "Batch install reports failed preflight and does not mutate any host configuration",
      passed: result.status !== 0 && JSON.parse(result.stdout).status === "preflight-failed" && JSON.parse(result.stdout).summary.applied === 0 && !nativeConfig,
      source: [{ file: "bin/portable-cli.mjs" }],
      trigger: "install --all in a project with existing .opencode/skills data",
      evidence: { exit: result.status, stdout: result.stdout, stderr: scrub(result.stderr).trim(), nativeConfigCreated: !!nativeConfig,
        nativePluginAdded: nativeConfig?.includes("opencode-autoskill") === true },
    };
  });
  const report = {
    schemaVersion: 2, purpose: "post-fix-regression-acceptance", auditedAt: new Date().toISOString(), platform: process.platform, nodeVersion: process.version,
    scope: "Isolated configuration and process-launch checks; no real client compatibility or model quality claim.",
    productionFilesModifiedByScript: false, passed: findings.every(finding => finding.passed === true), findings,
  };
  const destination = path.join(projectRoot, "artifacts", "project-audit-installation.json");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: destination, passed: report.passed, findings: findings.map(({ id, severity, category, passed }) => ({ id, severity, category, passed })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  const resolved = path.resolve(fixture);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("autoskill-audit-installation-")) throw new Error("Refusing unsafe fixture cleanup.");
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
