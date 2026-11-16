import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse } from "jsonc-parser";
import { runCli } from "../bin/autoskill.mjs";

const silent = { out() {}, error() {} };

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-install-"));
  const oldStateHome = process.env.AUTOSKILL_STATE_HOME;
  const oldConfigHome = process.env.AUTOSKILL_CONFIG_HOME;
  process.env.AUTOSKILL_STATE_HOME = path.join(root, "private-state");
  process.env.AUTOSKILL_CONFIG_HOME = path.join(root, "global-config");
  t.after(async () => {
    if (oldStateHome === undefined) delete process.env.AUTOSKILL_STATE_HOME; else process.env.AUTOSKILL_STATE_HOME = oldStateHome;
    if (oldConfigHome === undefined) delete process.env.AUTOSKILL_CONFIG_HOME; else process.env.AUTOSKILL_CONFIG_HOME = oldConfigHome;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-install-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  const pkg = path.join(root, "package");
  await fs.mkdir(project);
  await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
  await fs.writeFile(path.join(pkg, "dist", "index.js"), "export default {};\n");
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "opencode-autoskill", type: "module" }));
  return { root, project, pkg, privateState: process.env.AUTOSKILL_STATE_HOME, args: ["--project", project, "--package", pkg] };
}

test("install preserves comments and other plugins, is idempotent, and uninstall removes only AutoSkill", async t => {
  const { project, pkg, privateState, args } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  const original = `// team configuration\n{\n  "model": "example/model",\n  "plugins": [\n    // keep this plugin\n    { "package": "other-plugin", "options": { "custom": true } },\n  ],\n  // keep provider settings\n  "provider": { "private": { "options": { "apiKey": "must-not-print" } } }\n}\n`;
  await fs.writeFile(file, original);
  const output: string[] = [];
  const io = { out(value: string) { output.push(value); }, error() {} };
  assert.equal(await runCli(["install", ...args], io), 0);
  const installedText = await fs.readFile(file, "utf8");
  const installed = parse(installedText);
  assert.equal(installed.plugins.length, 2);
  assert.equal(installed.plugins[1].package, pkg.replaceAll("\\", "/"));
  assert.match(installedText, /\/\/ team configuration/);
  assert.match(installedText, /\/\/ keep this plugin/);
  assert.match(installedText, /\/\/ keep provider settings/);
  assert.equal(installed.provider.private.options.apiKey, "must-not-print");
  assert.ok(!output.join("\n").includes("must-not-print"));
  const backupGroups = await fs.readdir(path.join(privateState!, "config-backups"));
  const backupsDir = path.join(privateState!, "config-backups", backupGroups[0]!);
  const backups = await fs.readdir(backupsDir);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(backupsDir, backups[0]!), "utf8"), original);
  await runCli(["install", ...args], silent);
  assert.equal(await fs.readFile(file, "utf8"), installedText);
  assert.equal((await fs.readdir(backupsDir)).length, 1);
  // Changes made after installation must survive uninstallation.
  await fs.writeFile(file, installedText.replace('"example/model"', '"example/new-model"'));
  await runCli(["uninstall", ...args], silent);
  const removedText = await fs.readFile(file, "utf8");
  const removed = parse(removedText);
  assert.equal(removed.model, "example/new-model");
  assert.deepEqual(removed.plugins, [{ package: "other-plugin", options: { custom: true } }]);
  assert.match(removedText, /\/\/ keep this plugin/);
});

test("global and explicit config cannot mix and never create either scope", async t => {
  const { project, root, args, privateState } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, '{"model":"unchanged"}');
  await assert.rejects(runCli(["install", "--global", "--config", file], silent), /--global/);
  await assert.rejects(runCli(["install", ...args, "--global"], silent), /--global/);
  assert.equal(await fs.readFile(file, "utf8"), '{"model":"unchanged"}');
  assert.equal(await fs.readdir(root).then(entries => entries.includes("global-config")), false);
  await assert.rejects(fs.access(privateState!));
});

test("migration recognizes package identity, preserves options, and consolidates duplicates", async t => {
  const { project, root, pkg, args } = await fixture(t);
  const previous = path.join(root, "old-location");
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, "package.json"), JSON.stringify({ name: "opencode-autoskill" }));
  const config = path.join(project, "opencode.jsonc");
  await fs.writeFile(config, JSON.stringify({ plugins: [
    { package: previous, options: { enabled: false, minToolCalls: 12 } },
    "unrelated-plugin", "opencode-autoskill@0.1.0",
  ] }));
  const output: string[] = [];
  const io = { out(value: string) { output.push(value); }, error() {} };
  await runCli(["status", ...args], io);
  assert.equal(JSON.parse(output.pop()!).matchingEntries, 2);
  await runCli(["install", ...args], io);
  assert.equal(JSON.parse(output.pop()!).action, "migrated");
  const installed = parse(await fs.readFile(config, "utf8"));
  assert.equal(installed.plugins.length, 2);
  assert.equal(installed.plugins[0].package, pkg.replaceAll("\\", "/"));
  assert.deepEqual(installed.plugins[0].options, { enabled: false, minToolCalls: 12 });
  assert.equal(installed.plugins[1], "unrelated-plugin");
});

test("uninstall preserves valid compact arrays and trailing commas at each position", async t => {
  const { project, args } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  for (const text of [
    '{"plugins":["opencode-autoskill@0.1.0",]}',
    '{"plugins":["other","opencode-autoskill@0.1.0",]}',
    '{"plugins":["opencode-autoskill@0.1.0","other"]}',
    '{"plugins":["first","opencode-autoskill@0.1.0","last"]}',
  ]) {
    await fs.writeFile(file, text);
    await runCli(["uninstall", ...args], silent);
    const errors: unknown[] = [];
    const value = parse(await fs.readFile(file, "utf8"), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0);
    assert.equal(value.plugins.some((entry: string) => entry.includes("autoskill")), false);
  }
});

test("installation manifest recognizes a previously installed directory after it disappears", async t => {
  const { project, root, pkg, args } = await fixture(t);
  await runCli(["install", ...args], silent);
  const moved = path.join(root, "moved-plugin");
  await fs.rename(pkg, moved);
  const movedArgs = ["--project", project, "--package", moved];
  const output: string[] = [];
  await runCli(["status", ...movedArgs], { out(value: string) { output.push(value); }, error() {} });
  assert.equal(JSON.parse(output.pop()!).installed, true);
  await runCli(["install", ...movedArgs], silent);
  const installed = parse(await fs.readFile(path.join(project, "opencode.jsonc"), "utf8"));
  assert.equal(installed.plugins.length, 1);
  assert.equal(installed.plugins[0].package, moved.replaceAll("\\", "/"));
  await runCli(["uninstall", ...movedArgs], silent);
  assert.deepEqual(parse(await fs.readFile(path.join(project, "opencode.jsonc"), "utf8")).plugins, []);
});

test("explicit replacement migrates an unrecorded missing local reference", async t => {
  const { project, root, pkg, args } = await fixture(t);
  const missing = path.join(root, "deleted-v01-package");
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, JSON.stringify({ plugins: [{ package: missing, options: { minToolCalls: 12 } }, "other-plugin"] }));
  await runCli(["install", ...args, "--replace", missing], silent);
  const config = parse(await fs.readFile(file, "utf8"));
  assert.equal(config.plugins.length, 2);
  assert.equal(config.plugins[0].package, pkg.replaceAll("\\", "/"));
  assert.equal(config.plugins[0].options.minToolCalls, 12);
  assert.equal(config.plugins[1], "other-plugin");
});

test("private state cannot ignore an entire project and config cannot select another project", async t => {
  const { project, root, args } = await fixture(t);
  const config = path.join(project, "opencode.jsonc");
  await fs.writeFile(config, "{}");
  process.env.AUTOSKILL_STATE_HOME = root;
  await assert.rejects(runCli(["install", ...args], silent), /AUTOSKILL_STATE_HOME/);
  assert.equal(await fs.readFile(config, "utf8"), "{}");
  await fs.unlink(config);
  await assert.rejects(runCli(["install", ...args], silent), /AUTOSKILL_STATE_HOME/);
  await assert.rejects(fs.access(config));
  await assert.rejects(fs.access(path.join(root, ".gitignore")));
  await assert.rejects(runCli(["install", ...args, "--config", path.join(root, "opencode.jsonc")], silent), /同一项目目录/);
});

test("dry-run previews without touching configuration or private state", async t => {
  const { project, args, privateState } = await fixture(t);
  const output: string[] = [];
  await runCli(["install", ...args, "--dry-run"], { out(value: string) { output.push(value); }, error() {} });
  assert.equal(JSON.parse(output.pop()!).dryRun, true);
  await assert.rejects(fs.access(path.join(project, "opencode.jsonc")));
  await assert.rejects(fs.access(privateState!));
});

test("enable and disable preserve options; private configuration backups retain ten versions", async t => {
  const { project, args, privateState } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, '{"provider":{"key":"fake-private-value"}}');
  await runCli(["install", ...args], silent);
  for (let index = 0; index < 14; index++) await runCli([index % 2 ? "enable" : "disable", ...args], silent);
  const groups = await fs.readdir(path.join(privateState!, "config-backups"));
  assert.equal((await fs.readdir(path.join(privateState!, "config-backups", groups[0]!))).length, 10);
  assert.equal(await fs.readFile(path.join(privateState!, ".gitignore"), "utf8"), "*\n");
  await assert.rejects(fs.access(path.join(project, ".opencode", "autoskill", "config-backups")));
  assert.equal(parse(await fs.readFile(file, "utf8")).provider.key, "fake-private-value");
});

test("runtime status explains non-started projects without creating queue files", async t => {
  const { project, args } = await fixture(t);
  const output: string[] = [];
  await runCli(["status", ...args, "--runtime"], { out(value: string) { output.push(value); }, error() {} });
  assert.equal(JSON.parse(output.pop()!).runtime.status, "not-started");
  await assert.rejects(fs.access(path.join(project, ".opencode")));
});

test("doctor distinguishes unavailable CLI from a supported host and never prints unrelated credentials", async t => {
  const { project, args } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, '{"provider":{"apiKey":"fake-secret-never-print"},"plugins":[]}');
  const output: string[] = [];
  assert.equal(await runCli(["doctor", ...args, "--opencode", path.join(project, "missing-opencode")], { out(value: string) { output.push(value); }, error() {} }), 1);
  const result = JSON.parse(output.pop()!);
  assert.equal(result.opencodeVersion, "unavailable");
  assert.equal(result.supported, false);
  assert.equal(result.hostActivation, "not-observed");
  assert.doesNotMatch(JSON.stringify(result), /fake-secret-never-print/);
});

test("both configuration names require explicit selection", async t => {
  const { project, args } = await fixture(t);
  const json = path.join(project, "opencode.json");
  const jsonc = path.join(project, "opencode.jsonc");
  await fs.writeFile(json, "{}");
  await fs.writeFile(jsonc, "// selected\n{}");
  await assert.rejects(runCli(["install", ...args], silent), /--config/);
  assert.equal(await fs.readFile(json, "utf8"), "{}");
  await runCli(["install", ...args, "--config", jsonc], silent);
  assert.equal(await fs.readFile(json, "utf8"), "{}");
  assert.equal(parse(await fs.readFile(jsonc, "utf8")).plugins.length, 1);
});

test("doctor reports unknown options and masks configured sensitive fragments", async t => {
  const { project, args } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  const output: string[] = [];
  const io = { out(value: string) { output.push(value); }, error() {} };
  await fs.writeFile(file, JSON.stringify({ plugins: [{ package: "opencode-autoskill", options: { enabled: true, misspelledBudget: 20 } }] }));
  await runCli(["doctor", ...args, "--opencode", path.join(project, "missing-opencode")], io);
  assert.match(JSON.parse(output.pop()!).optionsError, /Unknown.*misspelledBudget/);
  await fs.writeFile(file, JSON.stringify({ plugins: [{ package: "opencode-autoskill", options: { sensitivePatterns: ["private-custom-fragment"] } }] }));
  await runCli(["doctor", ...args, "--opencode", path.join(project, "missing-opencode")], io);
  const result = JSON.parse(output.pop()!);
  assert.equal(result.optionsError, undefined);
  assert.deepEqual(result.effectiveOptions.sensitivePatterns, ["[configured fragment]"]);
  assert.doesNotMatch(JSON.stringify(result), /private-custom-fragment/);
});

test("invalid configuration and missing build fail without editing", async t => {
  const { project, pkg, args } = await fixture(t);
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, '{ "plugins": "wrong" }');
  await assert.rejects(runCli(["install", ...args], silent), /plugins/);
  assert.equal(await fs.readFile(file, "utf8"), '{ "plugins": "wrong" }');
  await fs.writeFile(file, "{}");
  await fs.unlink(path.join(pkg, "dist", "index.js"));
  await assert.rejects(runCli(["install", ...args], silent), /npm run build/);
  assert.equal(await fs.readFile(file, "utf8"), "{}");
});

test("status shows installation state without revealing unrelated configuration", async t => {
  const { project, args } = await fixture(t);
  const output: string[] = [];
  const io = { out(value: string) { output.push(value); }, error() {} };
  await runCli(["status", ...args], io);
  assert.equal(JSON.parse(output.pop()!).installed, false);
  await runCli(["install", ...args], silent);
  await runCli(["status", ...args], io);
  const status = JSON.parse(output.pop()!);
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  const file = path.join(project, "opencode.jsonc");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('"enabled": true', '"enabled": false'));
  await runCli(["status", ...args], io);
  assert.equal(JSON.parse(output.pop()!).enabled, false);
});

test("uninstall missing plugin does not create a configuration", async t => {
  const { project, args } = await fixture(t);
  await runCli(["uninstall", ...args], silent);
  await assert.rejects(fs.access(path.join(project, "opencode.jsonc")));
});
