import * as fs from "node:fs/promises";
import * as path from "node:path";
import { QueueStore } from "./jobs.js";
import { acquireFileLock } from "./lock.js";
import { atomicStateJson, ensurePrivateDirectory, regularStateFile } from "./state.js";
import { resolveStorageLayout } from "./storage-layout.js";
import { cleanEventEvidence } from "./portable/event-store.js";

/** Remove retained evidence while preserving ownership hashes and completed-job IDs. */
export async function cleanEvidence(root: string, options: { olderThanDays?: number; dryRun?: boolean } = {}): Promise<{ dryRun: boolean; jobs: number; files: number; eventTasks?: number; eventReceipts?: number }> {
  const days = options.olderThanDays ?? 30;
  if (!Number.isFinite(days) || days < 0) throw new Error("olderThanDays must be a nonnegative number.");
  const base = resolveStorageLayout(root).stateRoot;
  const cutoff = Date.now() - days * 86_400_000;
  let jobs = 0, files = 0;
  async function directory(target: string): Promise<boolean> {
    let current = path.resolve(root);
    const rootStat = await fs.lstat(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe evidence project root.");
    for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe evidence directory."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    return true;
  }
  if (!await directory(base)) return { dryRun: !!options.dryRun, jobs, files };
  const database = path.join(base, "runtime.sqlite");
  if (await regularStateFile(database)) {
    const queue = new QueueStore(root);
    try {
      const clear = (state: Awaited<ReturnType<QueueStore["read"]>>, mutate: boolean) => {
        for (const job of Object.values(state.jobs)) {
          if (!["saved", "skipped", "failed", "cancelled"].includes(job.status) || job.updatedAt > cutoff || !job.snapshot) continue;
          jobs++; if (mutate) { delete job.snapshot; delete job.draftDecision; }
        }
      };
      if (options.dryRun) clear(await queue.read(), false); else await queue.transaction((state) => clear(state, true));
    } finally { await queue.close(); }
  }
  async function scrub(file: string, draft = false): Promise<void> {
    if (!await regularStateFile(file, 2_000_000)) return;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (draft && !["published", "discarded"].includes(value.status)) return;
    const at = Date.parse(value.createdAt ?? value.provenance?.createdAt ?? value.source?.createdAt ?? "");
    if (!Number.isFinite(at) || at > cutoff) return;
    const assessments = [value.assessment, value.provenance?.assessment, value.source?.assessment, ...(draft ? [value.decision?.assessment] : [])];
    const assessmentEvidence = assessments.flatMap((assessment) => [...(assessment?.complexity?.dimensions ?? []).map((dimension: { evidence?: unknown[] }) => dimension.evidence), assessment?.value?.evidence]);
    const has = (Array.isArray(value.evidence) && value.evidence.length) || (Array.isArray(value.provenance?.evidence) && value.provenance.evidence.length) || (Array.isArray(value.source?.evidence) && value.source.evidence.length) || (draft && value.decision?.evidence?.length) || assessmentEvidence.some((citations) => Array.isArray(citations) && citations.length);
    if (!has) return;
    files++;
    if (!options.dryRun) {
      value.evidence = [];
      if (value.provenance) value.provenance.evidence = [];
      if (value.source) value.source.evidence = [];
      if (draft && value.decision) value.decision.evidence = [];
      for (const assessment of assessments) {
        if (!assessment || typeof assessment !== "object") continue;
        for (const dimension of assessment.complexity?.dimensions ?? []) dimension.evidence = [];
        if (assessment.value) assessment.value.evidence = [];
      }
      await atomicStateJson(file, value);
    }
  }
  for (const category of ["provenance", "backups", "drafts"]) {
    const dir = path.join(base, category); if (!await directory(dir)) continue;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const id = category === "drafts" ? entry.name.replace(/\.json$/, "") : entry.name;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) continue;
      if (category === "drafts" && (!entry.isFile() || !entry.name.endsWith(".json"))) continue;
      if (category !== "drafts" && !entry.isDirectory()) continue;
      const target = path.join(dir, entry.name);
      if (category !== "drafts" && !await directory(target)) continue;
      let release: (() => Promise<void>) | undefined;
      if (!options.dryRun) {
        await ensurePrivateDirectory(root);
        const locks = path.join(base, "locks"); await fs.mkdir(locks, { recursive: true }); await directory(locks);
        release = await acquireFileLock(path.join(locks, `${category === "drafts" ? "draft-" : ""}${id}.lock`), () => directory(locks), 5_000);
        if (!release) throw new Error("Evidence is being updated; retry cleanup later.");
      }
      try {
        if (category === "drafts") await scrub(target, true);
        else if (category === "provenance") { await scrub(path.join(target, "SOURCE.json")); await scrub(path.join(target, "PUBLISH.json")); }
        else for (const name of await fs.readdir(target)) if (/^[a-zA-Z0-9-]+\.SOURCE\.json$/.test(name)) await scrub(path.join(target, name));
      } finally { await release?.(); }
    }
  }
  const events = await cleanEventEvidence(root, options);
  return { dryRun: !!options.dryRun, jobs, files, ...(events.tasks || events.receipts ? { eventTasks: events.tasks, eventReceipts: events.receipts } : {}) };
}
