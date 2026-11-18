import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { installHost, portableCommand } from "../dist/portable/install.js";
import { doctorHost } from "../dist/portable/doctor.js";
import { runPortableCli } from "../bin/portable-cli.mjs";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-install-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("Codex recognizes quoted, escaped, dotted and inline existing TOML servers without mutation", async t => {
  for (const before of [
    '["mcp_servers"."autoskill"]\ncommand = "existing.exe"\n',
    "['mcp_servers'.'autoskill']\ncommand = 'existing.exe'\n",
    String.raw`["mcp_servers"."auto\u0073kill"]` + '\ncommand = "existing.exe"\n',
    'mcp_servers.autoskill = { command = "existing.exe" }\n',
    'mcp_servers = { autoskill = { command = "existing.exe" } }\n',
  ]) {
    const root = await fixture(t), file = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(file)); await fs.writeFile(file, before);
    assert.ok(parseToml(before).mcp_servers);
    await assert.rejects(installHost({ root, host: "codex" }), /conflicts/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    await assert.rejects(fs.access(path.join(root, ".codex", "hooks.json")));
    await assert.rejects(fs.access(path.join(root, ".autoskill", "config.json")));
  }
});

test("Codex preserves TOML examples and large integers and validates the complete output", async t => {
  const root = await fixture(t), file = path.join(root, ".codex", "config.toml");
  const before = '# Keep formatting\nlarge = 9223372036854775807\nexample = """\nautoskill = example\n[mcp_servers.autoskill]\n"""\n[notes]\nautoskill = "keep"\n';
  await fs.mkdir(path.dirname(file)); await fs.writeFile(file, before);
  await installHost({ root, host: "codex" });
  const installed = await fs.readFile(file, "utf8"), parsed = parseToml(installed, { integersAsBigInt: "asNeeded" });
  assert.ok(installed.startsWith(before)); assert.equal(parsed.large, 9223372036854775807n);
  assert.equal((parsed.mcp_servers as any).autoskill.command, process.execPath);
  await installHost({ root, host: "codex", action: "uninstall" });
  assert.equal(await fs.readFile(file, "utf8"), before);
  for (const invalid of ['[broken\n', 'mcp_servers = "user-value"\n', 'mcp_servers = { other = { command = "keep" } }\n']) {
    await fs.writeFile(file, invalid);
    await assert.rejects(installHost({ root, host: "codex" }), /Invalid TOML|cannot accept/);
    assert.equal(await fs.readFile(file, "utf8"), invalid);
  }
});

test("relative package entries launch from another project and missing entries fail before configuration writes", async t => {
  const root = await fixture(t), packageDir = path.join(await fixture(t), "package");
  const entry = path.join(packageDir, "bin", "autoskill.mjs");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const relative = path.relative(process.cwd(), packageDir);
  await installHost({ root, host: "cursor", packageDir: relative });
  const config = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.autoskill;
  assert.equal(config.args[0], entry); assert.ok(path.isAbsolute(config.args[0]));
  const launched = await promisify(execFile)(config.command, config.args, { cwd: root, windowsHide: true });
  assert.deepEqual(JSON.parse(launched.stdout), ["serve", "--host", "cursor", "--project", root]);
  const hook = portableCommand(root, "cursor", "hook", "stop", relative);
  const script = process.platform === "win32" ? Buffer.from(hook.split(" ").at(-1)!, "base64").toString("utf16le") : hook;
  assert.ok(script.includes(entry.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")));
  const absent = await fixture(t);
  await assert.rejects(installHost({ root: absent, host: "cursor", packageDir: path.join(absent, "missing"), dryRun: true }), /package entry/);
  assert.deepEqual(await fs.readdir(absent), []);
});

test("doctor distinguishes missing contributions and reinstall previews and restores them safely", async t => {
  const root = await fixture(t), hooks = path.join(root, ".cursor", "hooks.json"), mcp = path.join(root, ".cursor", "mcp.json");
  await installHost({ root, host: "cursor" });
  await fs.unlink(hooks);
  await fs.writeFile(mcp, JSON.stringify({ mcpServers: { custom: { command: "keep" } }, user: "preserve" }));
  const missing = await doctorHost({ root, host: "cursor", binary: process.execPath });
  assert.equal(missing.installationRecorded, true); assert.equal(missing.installed, false);
  assert.equal(missing.enabled, false); assert.equal(missing.configuredEnabled, true);
  assert.equal((missing.configuration as any).state, "missing"); assert.equal((missing.repair as any).safe, true);
  assert.ok(missing.checks.includes("configuration-missing"));
  const before = await fs.readFile(mcp, "utf8"), preview = await installHost({ root, host: "cursor", dryRun: true });
  assert.ok((preview.repairs as any[]).length > 1); assert.equal(await fs.readFile(mcp, "utf8"), before);
  await assert.rejects(fs.access(hooks));
  await installHost({ root, host: "cursor" });
  const repaired = await doctorHost({ root, host: "cursor", binary: process.execPath });
  assert.equal(repaired.installed, true); assert.equal(repaired.enabled, true);
  assert.deepEqual(JSON.parse(await fs.readFile(mcp, "utf8")).mcpServers.custom, { command: "keep" });
  assert.equal(JSON.parse(await fs.readFile(mcp, "utf8")).user, "preserve");
});

test("doctor reports modified or invalid configuration and repair never overwrites manual changes", async t => {
  const root = await fixture(t), mcp = path.join(root, ".cursor", "mcp.json"), hooks = path.join(root, ".cursor", "hooks.json");
  await installHost({ root, host: "cursor" });
  const modified = JSON.parse(await fs.readFile(mcp, "utf8")); modified.mcpServers.autoskill.command = "manual-command";
  const before = JSON.stringify(modified); await fs.writeFile(mcp, before); await fs.unlink(hooks);
  const status = await doctorHost({ root, host: "cursor", binary: process.execPath });
  assert.equal(status.installed, false); assert.equal((status.configuration as any).state, "drifted"); assert.equal(status.repair, undefined);
  assert.ok(status.checks.includes("configuration-drifted"));
  await assert.rejects(installHost({ root, host: "cursor" }), /changed/);
  assert.equal(await fs.readFile(mcp, "utf8"), before); await assert.rejects(fs.access(hooks));
  await fs.writeFile(mcp, '{"mcpServers":"manual-value"}');
  await assert.rejects(installHost({ root, host: "cursor" }), /changed/);
  await fs.writeFile(mcp, '{broken');
  const invalid = await doctorHost({ root, host: "cursor", binary: process.execPath });
  assert.ok((invalid.configuration as any).contributions.some(item => item.state === "invalid"));
});

test("Codex missing TOML contributions repair and uninstall without recreating missing files", async t => {
  const root = await fixture(t), file = path.join(root, ".codex", "config.toml");
  await installHost({ root, host: "codex" }); await fs.unlink(file);
  await installHost({ root, host: "codex" }); assert.ok(parseToml(await fs.readFile(file, "utf8")).mcp_servers);
  await fs.unlink(file); await fs.unlink(path.join(root, ".codex", "hooks.json"));
  await installHost({ root, host: "codex", action: "uninstall" });
  await assert.rejects(fs.access(file)); await assert.rejects(fs.access(path.join(root, ".codex", "hooks.json")));
});

test("doctor distinguishes intentional deactivation and the global switch from missing configuration", async t => {
  const root = await fixture(t); await installHost({ root, host: "generic" });
  const file = path.join(root, ".autoskill", "config.json"), config = JSON.parse(await fs.readFile(file, "utf8"));
  config.options.enabled = false; await fs.writeFile(file, JSON.stringify(config));
  const globallyDisabled = await doctorHost({ root, host: "generic" });
  assert.equal(globallyDisabled.installed, true); assert.equal(globallyDisabled.enabled, false); assert.equal(globallyDisabled.globallyEnabled, false);
  await installHost({ root, host: "generic", action: "disable" });
  const disabled = await doctorHost({ root, host: "generic" });
  assert.equal((disabled.configuration as any).state, "inactive"); assert.equal(disabled.repair, undefined);
  assert.ok(disabled.checks.includes("configuration-inactive"));
});

test("batch installation preflights every host before mutating legacy projects", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, ".opencode", "skills", "manual"), { recursive: true });
  await fs.writeFile(path.join(root, ".opencode", "skills", "manual", "SKILL.md"), "# Manual skill\n");
  const out: string[] = [], errors: string[] = [];
  const code = await runPortableCli(["install", "--all", "--project", root], { out: value => out.push(String(value)), error: value => errors.push(String(value)) });
  assert.equal(code, 1); const result = JSON.parse(out.join("\n"));
  assert.equal(result.status, "preflight-failed"); assert.equal(result.summary.applied, 0);
  assert.ok(result.failures.some(item => /migrate/.test(item.error))); assert.match(errors.join("\n"), /no host configuration was changed/);
  await assert.rejects(fs.access(path.join(root, "opencode.jsonc"))); await assert.rejects(fs.access(path.join(root, ".autoskill")));
});

test("batch installation reports completed and pending hosts after a post-preflight write failure", async t => {
  const root = await fixture(t);
  const script = `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const root = process.argv[1], original = fs.rename;
    let injected = false;
    fs.rename = async (from, to) => {
      if (to === path.join(root, ".gemini", "settings.json")) { injected = true; const error = new Error("injected disk full"); error.code = "ENOSPC"; throw error; }
      return original(from, to);
    };
    syncBuiltinESMExports();
    const { runPortableCli } = await import(${JSON.stringify(new URL("../bin/portable-cli.mjs", import.meta.url).href)});
    const out = [], errors = [];
    const code = await runPortableCli(["install", "--all", "--project", root], { out: value => out.push(value), error: value => errors.push(value) });
    process.stdout.write(JSON.stringify({ code, injected, result: JSON.parse(out.join("\\n")), errors }));
  `;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root], { windowsHide: true, timeout: 15000 });
  const report = JSON.parse(child.stdout);
  assert.equal(report.injected, true); assert.equal(report.code, 1); assert.equal(report.result.status, "partial-failure");
  assert.deepEqual(report.result.results.map(item => item.host), ["opencode", "claude-code", "codex"]);
  assert.equal(report.result.failures[0].host, "gemini"); assert.deepEqual(report.result.pending, ["cursor", "generic"]);
  assert.equal(report.result.summary.applied, 3);
  assert.ok(await fs.readFile(path.join(root, "opencode.jsonc"), "utf8"));
  await assert.rejects(fs.access(path.join(root, ".gemini", "settings.json")));
  await assert.rejects(fs.access(path.join(root, ".cursor", "mcp.json")));
});
