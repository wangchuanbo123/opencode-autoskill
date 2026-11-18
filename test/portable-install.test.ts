import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installHost, readPortableConfig, portableCommand, withNativeAdapterUpdate } from "../dist/portable/install.js";
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
  const command = portableCommand(root, "codex", "hook", "Stop");
  if (process.platform === "win32") { assert.match(command, /^powershell\.exe .* -EncodedCommand /); assert.match(Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le"), /--event/); }
  else assert.match(command, /--event/);
});
test("Windows hook launcher preserves shell metacharacters as literal arguments", { skip: process.platform !== "win32" }, async t => {
  const root = await fixture(t); const complex = path.join(root, "apostrophe's dollar$ percent% bang! backtick` spaces");
  const command = portableCommand(complex, "cursor", "hook", "stop");
  const decoded = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le"); assert.ok(decoded.includes("apostrophe''s dollar$ percent% bang! backtick` spaces")); assert.ok(decoded.startsWith("& '"));
});
test("Windows hook launcher executes from PowerShell and cmd with exact argv", { skip: process.platform !== "win32" }, async t => {
  const temporary = await fixture(t), packageDir = path.join(temporary, "package's $ percent% bang! `"), root = path.join(temporary, "项目's $ percent% bang! ` spaces");
  await fs.mkdir(path.join(packageDir, "bin"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "bin", "autoskill.mjs"), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const command = portableCommand(root, "cursor", "hook", "stop", packageDir), run = promisify(execFile);
  const expected = ["hook", "--host", "cursor", "--event", "stop", "--project", root];
  for (const [binary, args] of [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]], ["cmd.exe", ["/d", "/s", "/c", command]]] as const) {
    const result = await run(binary, [...args], { windowsHide: true, timeout: 15000, encoding: "utf8" }); assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});
test("portable config validates explicit capabilities and reviewer credential references", async t => {
  const root = await fixture(t), directory = path.join(root, ".autoskill"); await fs.mkdir(directory);
  const file = path.join(directory, "config.json"), base = { schemaVersion: 1, adapters: { cursor: { enabled: true, capabilities: ["shell", "read-files"] } }, options: {}, agentPolicy: "root-only" };
  await fs.writeFile(file, JSON.stringify(base)); assert.deepEqual((await readPortableConfig(root)).adapters.cursor?.capabilities, ["shell", "read-files"]);
  await installHost({ root, host: "cursor" }); assert.deepEqual((await readPortableConfig(root)).adapters.cursor?.capabilities, ["shell", "read-files"]);
  for (const capabilities of [[""], ["Uppercase"], ["read/files"], ["a".repeat(81)], Array.from({ length: 33 }, () => "shell"), "shell"]) {
    await fs.writeFile(file, JSON.stringify({ ...base, adapters: { cursor: { enabled: true, capabilities } } })); await assert.rejects(readPortableConfig(root), /capabilities/);
  }
  await fs.writeFile(file, JSON.stringify({ ...base, adapters: { cursor: { enabled: true, capabilities: ["opencode.session.hook", "filesystem:read", "tool_support-v2"] } } })); await readPortableConfig(root);
  for (const reviewer of [
    { type: "openai-compatible", baseUrl: "https://user:password@example.com/v1", model: "example", apiKeyEnv: "TEST_KEY" },
    { type: "openai-compatible", baseUrl: "https://example.com/v1?api_key=secret", model: "example", apiKeyEnv: "TEST_KEY" },
    { type: "openai-compatible", baseUrl: "https://example.com/v1", model: "example", apiKey: "plaintext-secret" },
    { type: "openai-compatible", baseUrl: "https://example.com/v1", model: "example", apiKeyEnv: "invalid/key" },
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...base, reviewer }));
    await assert.rejects(readPortableConfig(root), error => error instanceof Error && !/password|plaintext-secret|api_key=secret/.test(error.message));
  }
  for (const invalid of [
    { ...base, unknownField: true },
    { ...base, adapters: { cursor: { enabled: true, unknownField: true } } },
    { ...base, adapters: { cursor: { enabled: true, mode: "typo" } } },
    { ...base, options: { unknownOption: true } },
  ]) { await fs.writeFile(file, JSON.stringify(invalid)); await assert.rejects(readPortableConfig(root)); }
});
test("explicit native commands synchronize existing neutral overrides and roll back failures", async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, ".autoskill")); const file = path.join(root, ".autoskill", "config.json");
  const base = { schemaVersion: 1, adapters: { opencode: { enabled: false, capabilities: ["opencode.session.hook"] } }, options: {}, agentPolicy: "root-only" }; const before = JSON.stringify(base); await fs.writeFile(file, before);
  const preview = await withNativeAdapterUpdate(root, true, true, async () => { assert.equal((await readPortableConfig(root)).adapters.opencode?.enabled, false); return 0; }); assert.equal(preview.neutralAdapter?.changed, true); assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(withNativeAdapterUpdate(root, true, false, async () => { assert.equal((await readPortableConfig(root)).adapters.opencode?.enabled, true); throw new Error("native-failure"); }), /native-failure/); assert.equal(await fs.readFile(file, "utf8"), before);
  await withNativeAdapterUpdate(root, true, false, async () => 0); assert.equal((await readPortableConfig(root)).adapters.opencode?.enabled, true); assert.deepEqual((await readPortableConfig(root)).adapters.opencode?.capabilities, ["opencode.session.hook"]);
  const legacy = await fixture(t); await withNativeAdapterUpdate(legacy, false, false, async () => 0); await assert.rejects(fs.access(path.join(legacy, ".autoskill", "config.json")));
});
