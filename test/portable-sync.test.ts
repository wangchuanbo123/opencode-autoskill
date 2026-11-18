import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPortableConfig, sha256 } from "../dist/portable/install.js";
import { syncNativeSkills } from "../dist/portable/sync.js";
test("native sync uses provenance hashes and preserves manual edits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-sync-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skill = path.join(root, ".autoskill", "skills", "example", "SKILL.md"), provenance = path.join(root, ".autoskill", "runtime", "provenance", "example", "SOURCE.json");
  await fs.mkdir(path.dirname(skill), { recursive: true }); await fs.mkdir(path.dirname(provenance), { recursive: true });
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), JSON.stringify(defaultPortableConfig()));
  const content = '---\nname: example\ndescription: example\nmetadata:\n  autoskill: true\n---\n# Example\n'; await fs.writeFile(skill, content); await fs.writeFile(provenance, JSON.stringify({ skillId: "example", skillSha256: sha256(content) }));
  await syncNativeSkills({ root, host: "cursor", dryRun: true }); await assert.rejects(fs.access(path.join(root, ".cursor")));
  await syncNativeSkills({ root, host: "cursor" }); const target = path.join(root, ".cursor", "skills", "example", "SKILL.md"); assert.equal(await fs.readFile(target, "utf8"), content);
  await fs.appendFile(target, "manual"); const report = await syncNativeSkills({ root, host: "cursor" }); assert.deepEqual(report.conflicts, ["example"]); assert.match(await fs.readFile(target, "utf8"), /manual$/);
  await fs.unlink(skill); const pruned = await syncNativeSkills({ root, host: "cursor", prune: true }); assert.deepEqual(pruned.conflicts, ["example"]); assert.ok(await fs.stat(target));
});
test("native sync filters host/capability requirements and revokes incompatible owned copies", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-sync-compat-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = defaultPortableConfig(); config.adapters.codex = { enabled: true };
  await fs.mkdir(path.join(root, ".autoskill")); const configFile = path.join(root, ".autoskill", "config.json"); await fs.writeFile(configFile, JSON.stringify(config));
  for (const [id, compatibility] of [["native-only", { hosts: ["opencode"] }], ["browser-required", { requiredCapabilities: ["browser"] }], ["invalid-compat", { hosts: ["unknown"] }]] as const) {
    const directory = path.join(root, ".autoskill", "skills", id), provenance = path.join(root, ".autoskill", "runtime", "provenance", id); await fs.mkdir(directory, { recursive: true }); await fs.mkdir(provenance, { recursive: true });
    const content = `---\nname: ${id}\ndescription: fixture\nmetadata:\n  autoskill: true\n  autoskill-compatibility: ${JSON.stringify(compatibility)}\n---\n# Fixture\n`; await fs.writeFile(path.join(directory, "SKILL.md"), content); await fs.writeFile(path.join(provenance, "SOURCE.json"), JSON.stringify({ skillId: id, skillSha256: sha256(content) }));
  }
  const first = await syncNativeSkills({ root, host: "codex" }); assert.deepEqual(first.exported, []); assert.equal((first.skipped as any[]).length, 3); await assert.rejects(fs.access(path.join(root, ".agents", "skills", "native-only", "SKILL.md")));
  config.adapters.codex.capabilities = ["browser"]; await fs.writeFile(configFile, JSON.stringify(config));
  const second = await syncNativeSkills({ root, host: "codex" }); assert.deepEqual(second.exported, ["browser-required"]);
  config.adapters.codex.capabilities = []; await fs.writeFile(configFile, JSON.stringify(config));
  const third = await syncNativeSkills({ root, host: "codex" }); assert.deepEqual(third.revoked, ["browser-required"]); await assert.rejects(fs.access(path.join(root, ".agents", "skills", "browser-required", "SKILL.md")));
});
