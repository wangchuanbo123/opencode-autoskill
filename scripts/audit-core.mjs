/**
 * Fix acceptance checks: uses isolated temporary projects and writes only
 * artifacts/project-audit-core-fixed.json in this checkout. Run after npm run build.
 * The native-sync case injects one ENOSPC at the second destination rename via
 * Node's built-in module exports; no host files, real models or services run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsDefault from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ReuseEngine } from "../dist/reuse.js";
import { SkillStore } from "../dist/skills.js";
import { readOptions } from "../dist/config.js";
import { digest } from "../dist/tasks.js";
import { AutoSkillEngine } from "../dist/engine.js";
import { defaultPortableConfig, sha256 } from "../dist/portable/install.js";
import { syncNativeSkills } from "../dist/portable/sync.js";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const roots = [], engines = [], reuseEngines = [];
const findings = [];
async function temporaryProject(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `autoskill-audit-core-${name}-`));
  roots.push(root);
  return root;
}
async function portableProject(name) {
  const root = await temporaryProject(name);
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), JSON.stringify(defaultPortableConfig()));
  return root;
}
async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

try {
  // A specific supplemental search grounds a skill that the broad original
  // user prompt cannot retrieve. A restart must retain that admission evidence.
  const root = await portableProject("reuse");
  const corpus = JSON.parse(await fs.readFile(path.join(checkout, "evaluation", "reuse.json"), "utf8"));
  const store = new SkillStore(root);
  const skill = corpus.skills.find(item => item.id === "migration-lock-retry");
  await store.save({ action: "create", reason: "Trusted audit fixture", taskCompleted: true, reusable: true, confidence: .99,
    skill: { ...skill, pitfalls: [], verification: ["Run an independent targeted regression."] } },
  { sessionId: "source", fingerprint: "audit-source", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  const port = { root, hostId: "codex", workspaceId: "audit-workspace", snapshot: async () => { throw Error("unused"); },
    generate: async () => { throw Error("Retrieval must not call a model"); }, listSkills: async () => store.list(), reloadSkills: async () => {}, log() {} };
  const makeReuse = () => {
    const engine = new ReuseEngine(root, readOptions({ reuseAutoLoadLimit: 0, reuseCandidateLimit: 1 }), port);
    reuseEngines.push(engine); return engine;
  };
  const reuse = makeReuse(), original = "Investigate the performance regression";
  await reuse.prepare({ sessionId: "session", messageId: "user", text: original });
  await reuse.context("session", undefined, "user", digest(original), original);
  const search = await reuse.search({ sessionId: "session", query: "database migration lock retry" });
  const load = await reuse.load({ sessionId: "session", skillId: "migration-lock-retry" });
  const before = await reuse.context("session", undefined, "user", digest(original), original);
  const restarted = makeReuse();
  const after = await restarted.context("session", undefined, "user", digest(original), original);
  const marker = "Retry transient locks within a deadline";
  assert.equal(load.status, "loaded");
  const restartFixed = before.text.includes(marker) && after.text.includes(marker) && after.candidateIds.includes(skill.id);
  findings.push({ id: "reuse-refinement-lost-on-restart", severity: "P2", fixed: restartFixed,
    locations: ["src/reuse.ts:96", "src/reuse.ts:109", "src/reuse.ts:195"],
    trigger: "Prepare a broad original prompt; supplemental search finds a method; explicitly load it; restore a new ReuseEngine using the originalText and exact query hash.",
    expected: "The unchanged explicitly loaded method remains loaded after restart, subject to current safety and environment checks.",
    observed: { searchIds: search.candidates.map(item => item.id), loadStatus: load.status,
      bodyBeforeRestart: before.text.includes(marker), bodyAfterRestart: after.text.includes(marker), candidatesAfterRestart: after.candidateIds },
    impact: "Portable clients restore with originalText. The loaded procedure silently disappears after restart even though its candidate and durable load record remain.",
    suggestedDirection: "Persist privacy-safe supplemental admission/shortlist state, and restore it separately from the original prompt and user exclusions." });

  // Simulate a real partial filesystem failure: alpha is published, beta fails,
  // and the trailing ownership manifest therefore does not reach its commit.
  const syncRoot = await portableProject("sync");
  for (const id of ["alpha", "beta"]) {
    const directory = path.join(syncRoot, ".autoskill", "skills", id);
    const provenance = path.join(syncRoot, ".autoskill", "runtime", "provenance", id);
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(provenance, { recursive: true });
    const content = `---\nname: ${id}\ndescription: audit fixture\nmetadata:\n  autoskill: true\n---\n# Fixture\n`;
    await fs.writeFile(path.join(directory, "SKILL.md"), content);
    await fs.writeFile(path.join(provenance, "SOURCE.json"), JSON.stringify({ skillId: id, skillSha256: sha256(content) }));
  }
  const originalRename = fsDefault.rename;
  let destinationRenames = 0, faultInjected = false, syncError;
  fsDefault.rename = async (source, destination) => {
    if (String(destination).includes(`${path.sep}.cursor${path.sep}`) && ++destinationRenames === 2) {
      faultInjected = true;
      throw Object.assign(Error("Simulated ENOSPC during second native export rename"), { code: "ENOSPC" });
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try { await syncNativeSkills({ root: syncRoot, host: "cursor" }); }
  catch (error) { syncError = error.message; }
  finally { fsDefault.rename = originalRename; syncBuiltinESMExports(); }
  assert.equal(faultInjected, true);
  const retry = await syncNativeSkills({ root: syncRoot, host: "cursor" });
  const manifest = JSON.parse(await fs.readFile(path.join(syncRoot, ".autoskill", "exports", "cursor.json"), "utf8"));
  const alphaSource = path.join(syncRoot, ".autoskill", "skills", "alpha", "SKILL.md");
  await fs.unlink(alphaSource);
  const pruned = await syncNativeSkills({ root: syncRoot, host: "cursor", prune: true });
  const orphanRetained = await exists(path.join(syncRoot, ".cursor", "skills", "alpha", "SKILL.md"));
  findings.push({ id: "native-sync-loses-ownership-after-partial-write", severity: "P2",
    fixed: !retry.conflicts.includes("alpha") && !!manifest.skills.alpha && !orphanRetained && pruned.pruned.includes("alpha"),
    locations: ["src/portable/sync.ts:75", "src/portable/sync.ts:86", "src/portable/sync.ts:88"],
    trigger: "Synchronize two new native exports; inject ENOSPC on the second destination rename; retry; remove the first canonical method and run sync --prune.",
    faultInjection: "Temporarily replace node:fs/promises.rename via its default export and syncBuiltinESMExports; restore it in finally. Fault affects fixture .cursor destinations only.",
    expected: "A retry reconciles or rolls back the partial first export, retaining enough ownership evidence to safely update or prune it.",
    observed: { syncError, retryConflicts: retry.conflicts, retryExported: retry.exported,
      manifestIdsAfterRetry: Object.keys(manifest.skills), pruned: pruned.pruned, nativeOrphanRetainedAfterCanonicalDeletion: orphanRetained },
    impact: "A transient disk error creates a native skill permanently treated as a user conflict. Subsequent sync and prune cannot manage it, so hosts can keep discovering stale procedures.",
    suggestedDirection: "Use a recoverable export transaction journal with precomputed before/after hashes, and reconcile pending records before the next synchronization." });

  // Invalidation happens while capture awaits the host. Its later rejection
  // must not overwrite the cancellation created by the newer user revision.
  const captureRoot = await temporaryProject("capture");
  let rejectSnapshot, entered;
  const snapshotEntered = new Promise(resolve => { entered = resolve; });
  const capturePort = { root: captureRoot, hostId: "codex", workspaceId: "audit-workspace", backgroundWorker: false,
    options: { globalStateDirectory: path.join(captureRoot, "budget") },
    snapshot: async () => { entered(); return new Promise((_, reject) => { rejectSnapshot = reject; }); },
    generate: async () => { throw Error("No model should run in this case"); }, listSkills: async () => [], reloadSkills: async () => {}, log() {} };
  const engine = new AutoSkillEngine(capturePort); engines.push(engine);
  const capture = engine.enqueue("session", "success");
  await snapshotEntered; await engine.invalidate("session");
  const cancelled = await engine.status();
  rejectSnapshot(Error("Snapshot became unreadable after task revision"));
  const captureResult = await capture, retried = await engine.status();
  const beforeJob = cancelled.jobs[0], afterJob = retried.jobs[0];
  findings.push({ id: "capture-failure-revives-invalidated-request", severity: "P2",
    fixed: beforeJob.status === "cancelled" && afterJob.status === "cancelled" && captureResult.status === "cancelled",
    locations: ["src/engine.ts:150"],
    trigger: "enqueue waits in snapshot; invalidate the session; reject the in-flight snapshot.",
    expected: "The invalidated capture stays cancelled and returns a cancellation result.",
    observed: { stateAfterInvalidate: beforeJob.status, stateAfterSnapshotFailure: afterJob.status,
      retainedReasonCode: afterJob.reasonCode, captureResult },
    impact: "A user revision's cancellation is lost and the old capture request resumes retries, causing extra work and contradictory status. Late publication was not demonstrated by this audit.",
    suggestedDirection: "Update retry state only if the capture generation is still current and its durable state has not been cancelled or superseded." });

  // A successful older capture can also outlive invalidation. If a newer
  // capture has reused the same placeholder, the cancellation flag is gone.
  const generationRoot = await temporaryProject("generation");
  let resolveOlder, oldEntered, snapshotCalls = 0;
  const olderStarted = new Promise(resolve => { oldEntered = resolve; });
  const revisionSnapshot = revision => ({ sessionId: "session", hostId: "codex", workspaceId: "audit-workspace", directory: generationRoot,
    terminal: "success", revision, turnId: "turn", messages: [
      { id: "user", role: "user", text: "Investigate migration lock recovery and independently verify the diagnosis", tools: [] },
      { id: "assistant", role: "assistant", text: "Investigated and verified", tools: [
        { id: "diagnosis", name: "shell", status: "completed", input: { command: "inspect migration lock" },
          output: "Root cause: transient database migration lock because another transaction is unfinished; choose bounded retry after comparing lock recovery approaches." },
        { id: "verification", name: "shell", status: "completed", input: { command: "npm test migration-lock" },
          output: "Independent migration lock regression: 12 tests passed and lock retry verified." },
      ] },
    ] });
  const generationEngine = new AutoSkillEngine({ root: generationRoot, hostId: "codex", workspaceId: "audit-workspace", backgroundWorker: false,
    options: { minComplexityScore: 1, globalStateDirectory: path.join(generationRoot, "budget") },
    snapshot: async () => { if (++snapshotCalls === 1) { oldEntered(); return new Promise(resolve => { resolveOlder = resolve; }); } return revisionSnapshot(2); },
    generate: async () => { throw Error("No model should run in this case"); }, listSkills: async () => [], reloadSkills: async () => {}, log() {} });
  engines.push(generationEngine);
  const olderCapture = generationEngine.enqueue("session", "success");
  await olderStarted; await generationEngine.invalidate("session");
  const newerResult = await generationEngine.enqueue("session", "success");
  const during = await generationEngine.queue.read();
  resolveOlder(revisionSnapshot(1));
  const olderResult = await olderCapture, generationAfter = await generationEngine.queue.read();
  const summarize = state => Object.values(state.jobs).filter(job => job.snapshot).map(job => ({ revision: job.snapshot.revision, status: job.status, reasonCode: job.reasonCode }));
  findings.push({ id: "late-capture-cancels-newer-evidence", severity: "P2",
    fixed: Object.values(during.jobs).some(job => job.snapshot?.revision === 2 && job.status === "pending") &&
      Object.values(generationAfter.jobs).some(job => job.snapshot?.revision === 2 && job.status === "pending") &&
      !Object.values(generationAfter.jobs).some(job => job.snapshot?.revision === 1 && job.status === "pending") && olderResult.status === "cancelled",
    locations: ["src/engine.ts:140", "src/engine.ts:179", "src/engine.ts:193"],
    trigger: "Delay capture revision 1; invalidate it; complete capture revision 2 for the same task; resolve the delayed revision 1 snapshot.",
    expected: "Revision 2 remains pending and the superseded revision 1 capture cannot admit evidence.",
    observed: { newerResult, olderResult, afterNewCapture: summarize(during), afterOlderSnapshotArrives: summarize(generationAfter) },
    impact: "The newest completed evidence is cancelled by an older capture, so automatic review can be lost until another event or manual review. Late stale publication was not demonstrated.",
    suggestedDirection: "Give each capture an immutable generation/fence; compare it at every async resume and before cancelling other revisions." });
} finally {
  await Promise.all(engines.map(engine => engine.dispose()));
  await Promise.all(reuseEngines.map(engine => engine.close()));
  for (const root of roots) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("autoskill-audit-core-")) throw Error("Refusing unsafe audit cleanup");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
const report = { audit: "core-reliability", generatedAt: new Date().toISOString(), runtime: process.version,
  command: "node scripts/audit-core.mjs", productionFilesModified: false, findings };
const output = path.join(checkout, "artifacts", "project-audit-core-fixed.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, findings: findings.map(({ id, severity, fixed }) => ({ id, severity, fixed })) }, null, 2));
assert.ok(findings.every(finding => finding.fixed), "Every core audit regression must pass before acceptance.");
