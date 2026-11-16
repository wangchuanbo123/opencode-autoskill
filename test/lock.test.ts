import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { StateStore } from "../dist/state.js";
import { acquireFileLock, LockInspectionError } from "../dist/lock.js";

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-lock-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("autoskill-lock-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("SQLite locks serialize owners and old release cannot release the next owner", async (t) => {
  const root = await project(t);
  const stores = Array.from({ length: 8 }, () => new StateStore(root));
  const releases = await Promise.all(stores.map((store) => store.lock()));
  assert.equal(releases.filter(Boolean).length, 1);
  const first = releases.find(Boolean)!;
  await first();
  const next = await stores[0]!.lock();
  assert.ok(next);
  await first();
  assert.equal(await stores[1]!.lock(), undefined);
  await next();
  const again = await stores[1]!.lock();
  assert.ok(again);
  await again();
});

test("waiting writers acquire only after the prior transaction releases", async (t) => {
  const root = await project(t);
  const file = path.join(root, "test.lock");
  const prepare = async () => { assert.equal((await fs.lstat(root)).isSymbolicLink(), false); };
  const first = await acquireFileLock(file, prepare);
  assert.ok(first);
  let entered = false;
  const waiting = acquireFileLock(file, prepare, 1_000).then((release) => { entered = true; return release; });
  assert.equal(await acquireFileLock(file, prepare), undefined);
  assert.equal(entered, false);
  await first();
  const second = await waiting;
  assert.ok(second);
  await second();
  assert.ok((await fs.readdir(root)).some(name => name === "test.lock.sqlite"));
});

test("dead legacy owner migrates without deleting its tombstone; live and malformed records are preserved", async (t) => {
  const root = await project(t);
  const store = new StateStore(root);
  await (await store.lock())!();
  const file = path.join(root, ".opencode", "autoskill", "review.lock");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await once(child, "exit");
  const dead = JSON.stringify({ pid: child.pid, token: "dead-owner", createdAt: "old" });
  await fs.writeFile(file, dead);
  const migrated = await store.lock();
  assert.ok(migrated);
  await migrated();
  assert.equal(await fs.readFile(file, "utf8"), dead);
  for (const content of ["{incomplete", ""]) {
    await fs.writeFile(file, content);
    await assert.rejects(store.lock(), (error) => error instanceof LockInspectionError);
    assert.equal(await fs.readFile(file, "utf8"), content);
  }
  const live = JSON.stringify({ pid: process.pid, token: "live-owner" });
  await fs.writeFile(file, live);
  assert.equal(await store.lock(), undefined);
  assert.equal(await fs.readFile(file, "utf8"), live);
});

test("cross-process ownership is exclusive and abrupt owner exit automatically releases it", { timeout: 10_000 }, async (t) => {
  const root = await project(t);
  const script = `
    const { StateStore } = await import(${JSON.stringify(new URL("../dist/state.js", import.meta.url).href)});
    const release = await new StateStore(${JSON.stringify(root)}).lock();
    if (!release) process.exit(2);
    process.stdout.write("locked");
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [data] = await once(child.stdout!, "data");
  assert.equal(data.toString(), "locked");
  const store = new StateStore(root);
  assert.equal(await store.lock(), undefined);
  child.kill();
  await once(child, "exit");
  const release = await store.lock();
  assert.ok(release);
  await release();
});

test("non-regular lock paths, linked databases and sidecars are rejected", async (t) => {
  const root = await project(t);
  const store = new StateStore(root);
  await (await store.lock())!();
  const file = path.join(root, ".opencode", "autoskill", "review.lock");
  await fs.mkdir(file);
  await assert.rejects(store.lock(), /Unsafe AutoSkill lock/);
  await fs.rmdir(file);
  await fs.writeFile(file, "x".repeat(4_097));
  await assert.rejects(store.lock(), /Unsafe AutoSkill lock/);
  await fs.unlink(file);
  const database = `${file}.sqlite`;
  await fs.unlink(database);
  await fs.mkdir(database);
  await assert.rejects(store.lock(), /Unsafe AutoSkill SQLite/);
});
