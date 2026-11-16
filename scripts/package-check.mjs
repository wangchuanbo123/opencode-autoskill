#!/usr/bin/env node
// Verify one already-built tarball in an isolated npm installation and project.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownManifest = JSON.parse(await fs.readFile(path.join(ownRoot, "package.json"), "utf8"));
const artifact = path.resolve(process.argv[2] ?? `opencode-autoskill-${ownManifest.version}.tgz`);
assert.ok((await fs.stat(artifact)).isFile());
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-package-check-"));
const host = path.join(temporary, "host"), project = path.join(temporary, "project");
await fs.mkdir(host); await fs.mkdir(project);
const env = { ...process.env, AUTOSKILL_STATE_HOME: path.join(temporary, "private-state") };
async function run(command, args, cwd = host) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
  });
}
try {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run through npm run package-check -- <tarball> so npm can be resolved safely on Windows.");
  await run(process.execPath, [npmCli, "install", "--prefix", host, artifact, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const installed = path.join(host, "node_modules", "opencode-autoskill");
  const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, ownManifest.version);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["jsonc-parser", "yaml"]);
  await assert.rejects(fs.access(path.join(host, "node_modules", "@opencode", "plugin")));
  const plugin = (await import(pathToFileURL(path.join(installed, "dist", "index.js")).href)).default;
  assert.equal(plugin.id, "opencode-autoskill"); assert.equal(typeof plugin.setup, "function");
  const cli = path.join(installed, "bin", "autoskill.mjs");
  const config = path.join(project, "opencode.jsonc");
  await fs.writeFile(config, '{\n  // retained project option\n  "share": "disabled",\n  "plugins": []\n}\n');
  async function command(action, ...extra) { return JSON.parse(await run(process.execPath, [cli, action, ...extra, "--project", project])); }
  await command("install"); assert.equal((await command("status", "--runtime")).installed, true);
  assert.equal((await command("disable")).enabled, false);
  assert.equal((await command("enable")).enabled, true);
  await command("uninstall"); assert.equal((await command("status")).installed, false);
  assert.match(await fs.readFile(config, "utf8"), /retained project option/);
  const evaluation = await run(process.execPath, [path.join(installed, "scripts", "evaluate.mjs")]);
  const smoke = await run(process.execPath, [path.join(installed, "scripts", "smoke.mjs")]);
  const reuseSmoke = await run(process.execPath, [path.join(installed, "scripts", "reuse-smoke.mjs")]);
  console.log(JSON.stringify({ passed: true, tarball: path.basename(artifact), version: manifest.version, productionDependencies: Object.keys(manifest.dependencies),
    isolatedInstall: true, cliLifecycle: true, evaluation: JSON.parse(evaluation), hostSmoke: smoke.trim(), reuseHostSmoke: reuseSmoke.trim() }, null, 2));
} finally {
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("autoskill-package-check-")) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
