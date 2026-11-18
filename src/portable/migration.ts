import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { assertSafePath, defaultPortableConfig, ensurePortablePrivate, readSafeFile, sha256, writeSafeFile } from "./install.js";

interface MigrationFile { source: string; target: string; sha256: string; kind: "file" | "sqlite"; }
interface MigrationRecord { schemaVersion: 1; id: string; createdAt: string; files: MigrationFile[]; configHash: string; }
export interface MigrationOptions { root: string; dryRun?: boolean; rollback?: boolean; }
async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function walk(root: string, directory: string): Promise<string[]> {
  await assertSafePath(directory); if (!await exists(directory)) return [];
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Migration refuses symbolic links: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(root, file));
    else if (entry.isFile()) files.push(path.relative(root, file));
    else throw new Error(`Migration refuses non-regular files: ${file}`);
  }
  return files.sort();
}
function safeRelative(value: string): void { if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error("Migration manifest path escapes project."); }
function live(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function inspectQueue(db: DatabaseSync): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  if (tables.has("jobs")) for (const row of db.prepare("SELECT value FROM jobs").all() as { value: string }[]) inspectJob(JSON.parse(row.value));
  if (tables.has("runtime")) { const row = db.prepare("SELECT value FROM runtime WHERE key='state'").get() as { value: string } | undefined; if (row) inspectJsonQueue(JSON.parse(row.value)); }
}
function inspectJob(job: any): void {
  if (["pending", "running", "retry"].includes(job?.status) || live(job?.lease?.pid)) throw new Error("Migration requires an offline queue with no pending/running/retry jobs. Stop all hosts and finish or recover the queue before migrating.");
}
function inspectJsonQueue(value: any): void {
  if (value?.jobs && typeof value.jobs === "object") for (const job of Object.values(value.jobs)) inspectJob(job);
}

/** Offline copy migration. Originals remain intact; SQLite snapshots include WAL data. */
export async function migrateProject(input: MigrationOptions): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root), base = path.join(root, ".autoskill"), config = path.join(base, "config.json"), manifestFile = path.join(base, "migration.json");
  if (input.rollback) return rollbackMigration(input);
  if (await readSafeFile(config) !== undefined) throw new Error("Portable configuration already exists; migration would replace the authoritative store.");
  const files = [...await walk(root, path.join(root, ".opencode", "skills")), ...await walk(root, path.join(root, ".opencode", "autoskill"))];
  const sources = files.filter(file => !/\.(?:sqlite)-(?:wal|shm|journal)$/.test(file));
  const plan = await Promise.all(sources.map(async source => {
    const skillFile = source.startsWith(path.join(".opencode", "skills") + path.sep);
    let target = skillFile ? path.join(".autoskill", "skills", path.relative(path.join(".opencode", "skills"), source)) : path.join(".autoskill", "runtime", path.relative(path.join(".opencode", "autoskill"), source));
    if (skillFile && path.basename(source) === "SOURCE.json") {
      let provenance: any; try { provenance = JSON.parse(await readSafeFile(path.join(root, source)) ?? "null"); } catch { /* An unrelated skill resource is copied unchanged. */ }
      const id = path.basename(path.dirname(source));
      if (provenance?.skillId === id && /^[a-f0-9]{64}$/.test(provenance.skillSha256) && (provenance.schemaVersion === 1 || provenance.schemaVersion === 2 || typeof provenance.pluginVersion === "string")) {
        const authoritative = path.join(".opencode", "autoskill", "provenance", id, "SOURCE.json");
        target = sources.includes(authoritative) ? path.join(".autoskill", "runtime", "legacy-sidecars", path.relative(path.join(".opencode", "skills"), source)) : path.join(".autoskill", "runtime", "provenance", id, "SOURCE.json");
      }
    }
    return { source, target };
  }));
  if (new Set(plan.map(item => item.target)).size !== plan.length) throw new Error("Ambiguous legacy provenance destinations; inspect duplicate skill IDs before migration.");
  for (const item of plan) if (await exists(path.join(root, item.target))) throw new Error(`Migration destination exists: ${item.target}`);
  if (input.dryRun) return { status: "dry-run", files: plan, originalsPreserved: true, requiresOfflineQueue: true, databaseVerification: "performed when migration is applied" };
  await assertSafePath(base); await fs.mkdir(base, { recursive: true, mode: 0o700 }); await assertSafePath(base);
  const lockFile = path.join(base, "migration.lock"), lock = await fs.open(lockFile, "wx", 0o600).catch(error => { if (error.code === "EEXIST") throw new Error("Migration lock exists; inspect it after stopping every host before retrying."); throw error; });
  const id = randomUUID(), staging = path.join(base, `.migration-${id}`), held: DatabaseSync[] = [], readers: DatabaseSync[] = [];
  const committed: string[] = []; let manifestWritten = false;
  const record: MigrationRecord = { schemaVersion: 1, id, createdAt: new Date().toISOString(), files: [], configHash: "" };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, id, createdAt: new Date().toISOString() }));
    await ensurePortablePrivate(root);
    await fs.mkdir(staging, { mode: 0o700 });
    for (const item of plan) {
      const source = path.join(root, item.source), target = path.join(staging, path.relative(".autoskill", item.target));
      await assertSafePath(source); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (item.source.endsWith(".sqlite")) {
        const fence = new DatabaseSync(source, { timeout: 0 }); held.push(fence);
        try { fence.exec("BEGIN IMMEDIATE"); } catch { throw new Error(`Database is active; stop every host before migration: ${item.source}`); }
        const reader = new DatabaseSync(source, { readOnly: true }); readers.push(reader); inspectQueue(reader);
        await backup(reader, target);
        const check = new DatabaseSync(target);
        try {
          // Backups inherit the source WAL header. Normalize the isolated copy
          // before verification so its later read does not create untracked WAL
          // sidecars and rollback can compare every file exactly.
          check.exec("PRAGMA journal_mode=DELETE");
          const result = check.prepare("PRAGMA integrity_check").get() as Record<string, unknown>; if (Object.values(result)[0] !== "ok") throw new Error("Migrated SQLite integrity check failed.");
        } finally { check.close(); }
        record.files.push({ ...item, kind: "sqlite", sha256: sha256(await fs.readFile(target)) });
      } else {
        const before = await fs.readFile(source); const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source changed during migration.");
        if (item.source.endsWith(".lock")) { let owner: any; try { owner = JSON.parse(before.toString("utf8")); } catch { throw new Error("Unknown legacy lock owner; inspect before migration."); } if (live(owner.pid)) throw new Error("A legacy lock owner is running; stop every host before migration."); }
        if (path.basename(item.source) === "state.json") { try { inspectJsonQueue(JSON.parse(before.toString("utf8"))); } catch (error) { if (error instanceof SyntaxError) throw new Error("Invalid legacy queue JSON; inspect before migration."); throw error; } }
        await fs.writeFile(target, before, { flag: "wx", mode: 0o600 });
        if (sha256(await fs.readFile(source)) !== sha256(before)) throw new Error(`Source changed during migration: ${item.source}`);
        record.files.push({ ...item, kind: "file", sha256: sha256(before) });
      }
    }
    // Validate every staged byte before publishing directories and the layout marker.
    for (const file of record.files) if (sha256(await fs.readFile(path.join(staging, path.relative(".autoskill", file.target)))) !== file.sha256) throw new Error("Staged migration hash mismatch.");
    for (const file of record.files) if (file.kind === "file" && sha256(await fs.readFile(path.join(root, file.source))) !== file.sha256) throw new Error("Legacy data changed during migration; stop every host before retrying.");
    const finalSources = [...await walk(root, path.join(root, ".opencode", "skills")), ...await walk(root, path.join(root, ".opencode", "autoskill"))].filter(file => !/\.(?:sqlite)-(?:wal|shm|journal)$/.test(file)).sort();
    if (JSON.stringify(finalSources) !== JSON.stringify([...sources].sort())) throw new Error("Legacy files changed during migration; stop every host before retrying.");
    for (const name of ["runtime", "skills"]) {
      const source = path.join(staging, name), target = path.join(base, name);
      if (await exists(target)) throw new Error(`Migration destination exists: ${target}`);
      if (await exists(source)) { await fs.rename(source, target); committed.push(target); }
    }
    const configText = JSON.stringify(defaultPortableConfig(), null, 2) + "\n"; record.configHash = sha256(configText);
    await writeSafeFile(manifestFile, JSON.stringify(record, null, 2) + "\n", null); manifestWritten = true;
    await writeSafeFile(config, configText, null);
    return { status: "migrated", id, files: record.files.length, originalsPreserved: true, rollback: "autoskill migrate --rollback --project <project>" };
  } catch (error) {
    // Only unpublished destinations created by this operation are removed.
    if (await readSafeFile(config) === undefined) {
      for (const directory of committed.reverse()) {
        await assertSafePath(directory); if (path.dirname(directory) !== base) throw new Error("Unsafe migration rollback path.");
        const actual = await walk(root, directory), expected = record.files.filter(file => path.dirname(path.relative(directory, path.join(root, file.target))) !== ".." && !path.relative(directory, path.join(root, file.target)).startsWith(`..${path.sep}`));
        if (actual.length === expected.length && actual.every(file => expected.some(item => item.target === file)) && (await Promise.all(expected.map(async file => sha256(await fs.readFile(path.join(root, file.target))) === file.sha256))).every(Boolean)) await fs.rm(directory, { recursive: true, force: true });
        // Concurrent edits are left intact for inspection; never delete data
        // merely because its destination was created by this migration.
      }
      if (manifestWritten) await fs.unlink(manifestFile);
    }
    throw error;
  } finally {
    for (const reader of readers) reader.close();
    for (const db of held) { try { db.exec("ROLLBACK"); } catch { /* no active transaction */ } db.close(); }
    await lock.close(); await fs.unlink(lockFile);
    await assertSafePath(staging); if (path.dirname(staging) === base) await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Rollback is allowed only before migrated data/configuration acquires any edits. */
export async function rollbackMigration(input: MigrationOptions): Promise<Record<string, unknown>> {
  const root = path.resolve(input.root), base = path.join(root, ".autoskill"), manifestFile = path.join(base, "migration.json"), config = path.join(base, "config.json");
  const text = await readSafeFile(manifestFile); if (!text) throw new Error("No migration manifest found.");
  const record = JSON.parse(text) as MigrationRecord;
  if (record.schemaVersion !== 1 || !Array.isArray(record.files)) throw new Error("Invalid migration manifest.");
  if (sha256(await readSafeFile(config) ?? "") !== record.configHash) throw new Error("Portable configuration changed after migration; automatic rollback refused.");
  const expected = new Set(record.files.map(file => path.normalize(file.target)));
  const actual = [...await walk(root, path.join(base, "runtime")), ...await walk(root, path.join(base, "skills"))];
  if (actual.some(file => !expected.has(path.normalize(file))) || actual.length !== expected.size) throw new Error("Portable runtime gained files after migration; automatic rollback refused.");
  for (const file of record.files) {
    safeRelative(file.source); safeRelative(file.target);
    if (!file.source.startsWith(`.opencode${path.sep}`) || !file.target.startsWith(`.autoskill${path.sep}`)) throw new Error("Invalid migration manifest paths.");
    const destination = path.join(root, file.target); await assertSafePath(destination);
    if (sha256(await fs.readFile(destination)) !== file.sha256) throw new Error(`Migrated data changed; rollback refused: ${file.target}`);
    if (!await exists(path.join(root, file.source))) throw new Error("Original migration source is missing.");
    if (file.kind === "file" && sha256(await fs.readFile(path.join(root, file.source))) !== file.sha256) throw new Error("Original source changed; rollback refused.");
  }
  if (input.dryRun) return { status: "dry-run", action: "rollback", files: record.files.length };
  const lock = await fs.open(path.join(base, "migration.lock"), "wx", 0o600);
  try {
    if (sha256(await readSafeFile(config) ?? "") !== record.configHash) throw new Error("Configuration changed during rollback.");
    for (const file of record.files) if (sha256(await fs.readFile(path.join(root, file.target))) !== file.sha256) throw new Error("Data changed during rollback.");
    // Rename the marker first to atomically return new instances to legacy paths;
    // keep neutral snapshots recoverable instead of recursively deleting them.
    await fs.rename(config, path.join(base, `config.rolled-back-${record.id}.json`));
    await fs.rename(manifestFile, path.join(base, `migration.rolled-back-${record.id}.json`));
    for (const name of ["runtime", "skills"]) if (await exists(path.join(base, name))) await fs.rename(path.join(base, name), path.join(base, `${name}.rolled-back-${record.id}`));
    return { status: "rolled-back", originalsPreserved: true, snapshotsPreserved: true };
  } finally { await lock.close(); await fs.unlink(path.join(base, "migration.lock")); }
}
