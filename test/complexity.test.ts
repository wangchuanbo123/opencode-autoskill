import test from "node:test";
import assert from "node:assert/strict";
import { assessComplexity, COMPLEXITY_POLICY_VERSION } from "../dist/tasks.js";
import { readOptions } from "../dist/config.js";
import type { TaskSnapshot, ToolRecord } from "../src/types.ts";

const snapshot = (tools: ToolRecord[], text = "Complete the requested work"): TaskSnapshot => ({ sessionId: "complexity", directory: process.cwd(), terminal: "success", messages: [
  { id: "u", role: "user", text, tools: [] }, { id: "a", role: "assistant", text: "Completed", tools },
] });
const tool = (id: string, name: string, input: unknown, output: string, status: ToolRecord["status"] = "completed"): ToolRecord => ({ id, name, input, output, status });
const inspect = tool("cause", "shell", { command: "node reproduce-lock.js" }, "Root cause: migration lock timeout occurs because retry attempts overlap. Compared fixed delay versus bounded exponential backoff; bounded backoff avoids contention.");
const verify = tool("verification", "shell", { command: "npm test -- migration-lock" }, "Independent migration lock regression verified: bounded backoff prevents contention; 12 tests passed.");

test("many identical or distinct file reads cannot qualify by call count", () => {
  for (const uniquePaths of [false, true]) {
    const tools = Array.from({ length: 100 }, (_, index) => tool(`read-${index}`, "read", { file: uniquePaths ? `docs/${index}.md` : "package.json" }, "The project version is 1.0.0"));
    const assessment = assessComplexity(snapshot(tools), readOptions({ minToolCalls: 1, minToolCallsWithErrors: 1, minComplexityScore: 1 }));
    assert.equal(assessment.eligible, false);
    assert.ok(assessment.reasonCodes.includes("no_substantive_complexity_signal"));
    assert.equal(assessment.repeatedOperations, uniquePaths ? 0 : 99);
  }
});

test("command typos and unchanged retries do not become complex through errors", () => {
  const typo = [tool("wrong", "shell", "gti status", "gti: command not found", "error"), tool("fixed", "shell", "git status", "Working tree clean"), tool("check", "check", "git diff --stat", "Verified zero changed lines")];
  const retries = [tool("failed", "shell", "npm test", "Temporary connection failure", "error"), ...Array.from({ length: 8 }, (_, index) => tool(`repeat-${index}`, "shell", "npm test", "12 tests passed"))];
  for (const tools of [typo, retries]) {
    const assessment = assessComplexity(snapshot(tools), readOptions({ minToolCalls: 1, minToolCallsWithErrors: 1 }));
    assert.equal(assessment.eligible, false); assert.equal(assessment.dimensions.diagnosticResolution.present, false);
  }
});

test("two actual observations can establish a diagnosis and independent check", () => {
  const assessment = assessComplexity(snapshot([inspect, verify]), readOptions());
  assert.equal(assessment.eligible, true); assert.equal(assessment.version, COMPLEXITY_POLICY_VERSION);
  assert.equal(assessment.uniqueOperations, 2); assert.equal(assessment.logicalSteps, 2);
  assert.ok(assessment.dimensions.investigation.toolCallIds.includes("cause"));
  assert.ok(assessment.signals.includes("decisionEvidence")); assert.deepEqual(assessment.reasonCodes, []);
});

test("goal language and an unrelated passing test cannot supply missing causal evidence", () => {
  const claimed = snapshot([tool("read", "read", "src/cache.ts", "export const ttl = 5"), verify], "Perform a complex root cause investigation and choose a sophisticated strategy");
  assert.equal(assessComplexity(claimed, readOptions()).eligible, false);
  const unrelated = snapshot([inspect, tool("css", "test", "npm test -- styles", "CSS color contrast assertions passed")]);
  assert.equal(assessComplexity(unrelated, readOptions()).eligible, false);
});

test("a routine read/edit/test sequence still needs a substantive decision or coordination", () => {
  const tools = [tool("read", "read", { file: "docs/title.md" }, "# Old title"), tool("edit", "edit", { file: "docs/title.md", old: "Old", new: "New" }, "Updated title"), tool("check", "check", { file: "docs/title.md" }, "Title check verified: replacement matches")];
  const assessment = assessComplexity(snapshot(tools), readOptions());
  assert.equal(assessment.eligible, false); assert.ok(assessment.dimensions.dependencyChain.present);
  assert.equal(assessment.dimensions.decisionEvidence.present, false);
});

test("Code Mode call volume does not imply dependency or nonmechanical work", () => {
  const code = Array.from({ length: 40 }, () => "await tools.read({file:'package.json'});").join("\n");
  const assessment = assessComplexity(snapshot([tool("batch", "execute", { code }, "All reads returned the same version"), tool("check", "check", "npm pkg get version", "Version lookup verified: 1.0.0")]), readOptions());
  assert.equal(assessment.logicalSteps, 41); assert.equal(assessment.eligible, false);
  assert.equal(assessment.dimensions.dependencyChain.present, false);
});

test("Code Mode data-dependent correction qualifies only with a separate matching verification", () => {
  const batch = tool("batch", "execute", { code: "const source = await tools.read({file:'src/cache.ts'}); if(source.includes('invoiceId')) await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); return source;" }, "Root cause: src/cache.ts key omits tenant ID, causing invoice cache collisions. Updated tenant-aware key to isolate records.");
  const check = tool("check", "shell", "node --test test/cache-isolation.test.js", "Independent tenant cache isolation verified: 6 tests passed");
  assert.equal(assessComplexity(snapshot([batch, check]), readOptions()).eligible, true);
  assert.equal(assessComplexity(snapshot([batch]), readOptions()).eligible, false);
});

test("verification subjects match meaningful components of compound filenames and identifiers", () => {
  const batch = tool("batch", "execute", { code: "const source = await tools.read({file:'src/cache.ts'}); if(source.includes('invoiceId')) await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); return source;" }, "Root cause: cache key omits tenantId, causing collisions between tenants. Updated isolation strategy.");
  for (const separator of ["-", "_"]) {
    const check = tool("check", "shell", `node --test test/cache${separator}isolation.test.js`, "Independent tenant-isolation regression verified: 6 tests passed");
    assert.equal(assessComplexity(snapshot([batch, check]), readOptions()).eligible, true);
  }
});

test("Code Mode return and log reuse cannot connect an unrelated transformation", () => {
  for (const use of [
    "await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); return source;",
    "await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); console.log(source);",
    "await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); return {source};",
    "if (source) { console.log(source); } await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'});",
    "await tools.apply_patch({file:'src/cache.ts',patch:'source'});",
  ]) {
    const batch = tool("batch", "execute", { code: `const source = await tools.read({file:'src/cache.ts'}); ${use}` }, "Root cause: cache key omits tenantId, causing collisions between tenants. Updated isolation strategy.");
    const check = tool("check", "shell", "node --test test/cache-isolation.test.js", "Independent tenant-isolation regression verified: 6 tests passed");
    const assessment = assessComplexity(snapshot([batch, check]), readOptions());
    assert.equal(assessment.eligible, false);
    assert.equal(assessment.dimensions.dependencyChain.present, false);
  }
});

test("Code Mode read values connect to transformation arguments and enclosing conditions", () => {
  for (const mutation of [
    "await tools.write({file:'src/cache.ts',content:source});",
    "if (source.includes('invoiceId')) { await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); }",
    "const samples = await tools.shell({command:'node reproduce-cache.js'}); if (samples.includes('collision')) { await tools.apply_patch({file:'src/cache.ts',patch:'include tenantId'}); }",
  ]) {
    const batch = tool("batch", "execute", { code: `const source = await tools.read({file:'src/cache.ts'}); ${mutation}` }, "Root cause: cache key omits tenantId, causing collisions between tenants. Updated isolation strategy.");
    const check = tool("check", "shell", "node --test test/cache-isolation.test.js", "Independent tenant-isolation regression verified: 6 tests passed");
    assert.equal(assessComplexity(snapshot([batch, check]), readOptions()).eligible, true);
  }
});

test("unfinished operations and echoed verification remain ineligible", () => {
  const pending = snapshot([inspect, { ...verify, status: "pending" }]);
  assert.equal(assessComplexity(pending, readOptions()).eligible, false);
  assert.equal(assessComplexity(snapshot([inspect, { ...verify, input: "echo tests passed" }]), readOptions()).eligible, false);
});

test("legacy call thresholds have no effect on eligibility", () => {
  const evidence = snapshot([inspect, verify]);
  assert.deepEqual(assessComplexity(evidence, readOptions({ minToolCalls: 1, minToolCallsWithErrors: 1 })), assessComplexity(evidence, readOptions({ minToolCalls: 1000, minToolCallsWithErrors: 1000 })));
});
