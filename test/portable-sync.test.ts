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
