import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { cleanEvidence } from "../dist/maintenance.js";
import { assessmentFor } from "./helpers/assessment.ts";

test("cleanup removes assessment-only citations from sources, journals, backups and terminal drafts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-assessment-clean-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-assessment-clean-")); await fs.rm(root, { recursive: true, force: true }); });
  const assessment = assessmentFor([{ toolCallId: "procedure", excerpt: "PRIVATE_ASSESSMENT_PROCEDURE" }, { toolCallId: "verification", excerpt: "PRIVATE_ASSESSMENT_VERIFICATION" }]);
  const source = { createdAt: "2020-01-01T00:00:00.000Z", skillId: "owned", skillSha256: "a".repeat(64), taskId: "completed", assessment };
  const base = path.join(root, ".opencode/autoskill");
  const cases = [
    ["provenance/owned/SOURCE.json", source],
    ["provenance/owned/PUBLISH.json", { nextHash: "a".repeat(64), source }],
    ["backups/owned/2020-01.SOURCE.json", source],
    ["drafts/completed.json", { createdAt: source.createdAt, status: "published", provenance: source, decision: { assessment } }],
    ["drafts/pending.json", { createdAt: source.createdAt, status: "draft", provenance: source, decision: { assessment } }],
  ] as const;
  for (const [relative, value] of cases) {
    const file = path.join(base, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value));
  }
  assert.equal((await cleanEvidence(root, { olderThanDays: 1, dryRun: true })).files, 4);
  assert.match(await fs.readFile(path.join(base, cases[0][0]), "utf8"), /PRIVATE_ASSESSMENT/);
  assert.equal((await cleanEvidence(root, { olderThanDays: 1 })).files, 4);
  for (const [relative] of cases.slice(0, 4)) {
    const text = await fs.readFile(path.join(base, relative), "utf8");
    assert.doesNotMatch(text, /PRIVATE_ASSESSMENT/);
    assert.match(text, /"nontrivial": true/);
    assert.match(text, new RegExp("a".repeat(64)));
  }
  assert.match(await fs.readFile(path.join(base, "drafts/pending.json"), "utf8"), /PRIVATE_ASSESSMENT/);
  assert.equal((await cleanEvidence(root, { olderThanDays: 1 })).files, 0);
});
