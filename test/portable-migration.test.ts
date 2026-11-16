import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateProject } from "../dist/portable/migration.js";
async function fixture(t: any) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-migrate-")); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(path.join(root, ".opencode", "autoskill"), { recursive: true }); return root; }
test("migration snapshots WAL SQLite data, preserves originals and rolls back", async t => {
  const root = await fixture(t), source = path.join(root, ".opencode", "autoskill", "runtime.sqlite");
  const db = new DatabaseSync(source); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT,value TEXT); INSERT INTO jobs VALUES ('done','{\"status\":\"saved\"}');");
  const result = await migrateProject({ root }); assert.equal(result.status, "migrated");
  const migrated = new DatabaseSync(path.join(root, ".autoskill", "runtime", "runtime.sqlite"), { readOnly: true }); assert.equal((migrated.prepare("SELECT count(*) AS n FROM jobs").get() as any).n, 1); migrated.close(); db.close();
  assert.equal((await migrateProject({ root, rollback: true })).status, "rolled-back"); assert.ok(await fs.stat(source));
});
test("migration refuses pending queues and dry-run writes nothing", async t => {
  const root = await fixture(t), source = path.join(root, ".opencode", "autoskill", "runtime.sqlite");
  const db = new DatabaseSync(source); db.exec("CREATE TABLE jobs(id TEXT,value TEXT); INSERT INTO jobs VALUES ('active','{\"status\":\"pending\"}');"); db.close();
  await migrateProject({ root, dryRun: true }); await assert.rejects(fs.access(path.join(root, ".autoskill")));
  await assert.rejects(migrateProject({ root }), /offline queue/); await assert.rejects(fs.access(path.join(root, ".autoskill", "config.json")));
});
