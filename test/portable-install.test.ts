import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installHost, readPortableConfig, portableCommand } from "../dist/portable/install.js";
async function fixture(t: any) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-portable-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
test("portable installation preserves unrelated hooks and removes only owned contributions", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, ".claude"));
  const settings = path.join(root, ".claude", "settings.json"); await fs.writeFile(settings, '{\n// Keep comment\n"permissions":{"allow":["Read"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo custom"}]}]}}');
  await installHost({ root, host: "claude-code" });
  const installed = JSON.parse((await fs.readFile(settings, "utf8")).replace("// Keep comment", "")); assert.equal(installed.hooks.Stop.length, 2);
  installed.permissions.allow.push("Write"); await fs.writeFile(settings, JSON.stringify(installed));
  await installHost({ root, host: "claude-code", action: "uninstall" });
  const after = JSON.parse(await fs.readFile(settings, "utf8")); assert.deepEqual(after.permissions.allow, ["Read", "Write"]); assert.equal(after.hooks.Stop.length, 1); assert.equal(after.hooks.Stop[0].hooks[0].command, "echo custom");
  assert.equal((await readPortableConfig(root)).adapters["claude-code"]?.enabled, false);
});
test("dry-run creates no files and repeated install is idempotent", async t => {
  const root = await fixture(t); await installHost({ root, host: "cursor", dryRun: true }); assert.deepEqual(await fs.readdir(root), []);
  await installHost({ root, host: "cursor" }); const before = await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8");
  await installHost({ root, host: "cursor" }); assert.equal(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"), before);
});
test("modified owned configuration and legacy data are preserved", async t => {
  const root = await fixture(t); await installHost({ root, host: "gemini" });
  const file = path.join(root, ".gemini", "settings.json"), value = JSON.parse(await fs.readFile(file, "utf8")); value.mcpServers.autoskill.command = "custom"; await fs.writeFile(file, JSON.stringify(value));
  await assert.rejects(installHost({ root, host: "gemini", action: "uninstall" }), /changed/); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.autoskill.command, "custom");
  const legacy = await fixture(t); await fs.mkdir(path.join(legacy, ".opencode", "autoskill"), { recursive: true }); await fs.writeFile(path.join(legacy, ".opencode", "autoskill", "state.json"), "{}");
  await assert.rejects(installHost({ root: legacy, host: "codex" }), /migrate/); await assert.rejects(fs.access(path.join(legacy, ".autoskill", "config.json")));
});
test("Codex managed TOML append preserves unknown fields on removal", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, ".codex")); const file = path.join(root, ".codex", "config.toml"); const before = '# custom\nmodel="keep"\n[other]\nx = 42\n'; await fs.writeFile(file, before);
  await installHost({ root, host: "codex" }); await fs.appendFile(file, '\n[new_table]\nvalue = true\n'); await installHost({ root, host: "codex", action: "uninstall" }); assert.equal(await fs.readFile(file, "utf8"), before + '\n[new_table]\nvalue = true\n');
  assert.match(portableCommand(root, "codex", "hook", "Stop"), /--event/);
});
