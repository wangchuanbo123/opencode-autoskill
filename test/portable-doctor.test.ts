import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { doctorHost } from "../dist/portable/doctor.js";
import { installHost } from "../dist/portable/install.js";
test("doctor distinguishes configuration, observation, and verification", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-doctor-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await doctorHost({ root, host: "cursor", binary: process.execPath }); assert.equal(before.installed, false); assert.equal(before.observed, null); assert.equal(before.verified, false); assert.equal(before.detected, true); assert.deepEqual(await fs.readdir(root), []);
  await installHost({ root, host: "cursor" }); await fs.mkdir(path.join(root, ".autoskill", "runtime"), { recursive: true });
  const db = new DatabaseSync(path.join(root, ".autoskill", "runtime", "events.sqlite")); db.exec("CREATE TABLE adapter_observations(host TEXT PRIMARY KEY,value TEXT NOT NULL)"); db.prepare("INSERT INTO adapter_observations VALUES(?,?)").run("cursor", JSON.stringify({ lastEventAt: 123, eventName: "stop", coverage: { tools: "partial" } })); db.close();
  const after = await doctorHost({ root, host: "cursor", binary: process.execPath }); assert.equal(after.installed, true); assert.equal((after.observed as any).eventName, "stop"); assert.equal(after.verified, false);
  assert.match(await fs.readFile(path.join(root, ".autoskill", ".gitignore"), "utf8"), /config-backups\//);
});
test("doctor reports native OpenCode configuration without portable install manifests", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-doctor-native-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "opencode.json"); await fs.writeFile(file, JSON.stringify({ plugins: [{ package: "opencode-autoskill", options: { enabled: true } }] }));
  const enabled = await doctorHost({ root, host: "opencode", binary: process.execPath }); assert.equal(enabled.installed, true); assert.equal(enabled.enabled, true); assert.equal(enabled.nativeStatusAvailable, true); assert.equal((enabled.reviewer as any).type, "native-host-model");
  await fs.writeFile(file, JSON.stringify({ plugins: [{ package: "opencode-autoskill", options: { enabled: false } }] }));
  const disabled = await doctorHost({ root, host: "opencode", binary: process.execPath }); assert.equal(disabled.installed, true); assert.equal(disabled.enabled, false);
});
test("doctor reports only parsed versions from secret-bearing probe output", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-doctor-probe-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, process.platform === "win32" ? "probe.cmd" : "probe.sh");
  await fs.writeFile(binary, process.platform === "win32" ? '@echo off\necho private-probe-secret\necho tool 1.2.3\n' : '#!/bin/sh\nprintf "private-probe-secret\\ntool 1.2.3\\n"\n', { mode: 0o700 });
  const result = await doctorHost({ root, host: "cursor", binary }); assert.equal(result.version, "1.2.3"); assert.doesNotMatch(JSON.stringify(result), /private-probe-secret/);
});
