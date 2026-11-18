import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPortableCli } from "../bin/portable-cli.mjs";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-human-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function cli(args: string[]) {
  const out: string[] = [], errors: string[] = [];
  const code = await runPortableCli(args, { out: value => out.push(String(value)), error: value => errors.push(String(value)) });
  return { code, text: out.join("\n"), errors };
}
test("human install explains reviewer setup and doctor shows missing configuration with repair preview", async t => {
  const root = await fixture(t);
  const preview = await cli(["install", "--host", "cursor", "--project", root, "--dry-run", "--human"]);
  assert.equal(preview.code, 0); assert.match(preview.text, /预览|变更/); assert.deepEqual(await fs.readdir(root), []);
  const installed = await cli(["install", "--host", "cursor", "--project", root, "--human"]);
  assert.match(installed.text, /自动复盘等待配置 reviewer/); assert.match(installed.text, /\.autoskill\/config\.json/);
  await fs.unlink(path.join(root, ".cursor", "mcp.json")); await fs.unlink(path.join(root, ".cursor", "hooks.json"));
  const doctor = await cli(["doctor", "--host", "cursor", "--project", root, "--binary", process.execPath, "--human"]);
  assert.match(doctor.text, /实际配置缺失/); assert.match(doctor.text, /修复预览/); assert.match(doctor.text, /--dry-run/);
  assert.match(doctor.text, /客户端验收：未验证/);
});
test("default JSON remains compatible for single and batch previews and human status summarizes runtime", async t => {
  const root = await fixture(t);
  const single = await cli(["install", "--host", "cursor", "--project", root, "--dry-run"]);
  assert.equal(JSON.parse(single.text).status, "dry-run");
  const batch = await cli(["install", "--all", "--project", root, "--dry-run"]);
  assert.equal(batch.code, 0); assert.equal(JSON.parse(batch.text).length, 6);
  assert.deepEqual(await fs.readdir(root), []);
  const applied = await cli(["install", "--all", "--project", root]);
  assert.equal(applied.code, 0); assert.equal(JSON.parse(applied.text).length, 6);
  const status = await cli(["status", "--host", "generic", "--project", root, "--human"]);
  assert.match(status.text, /技能检索与加载可用/); assert.match(status.text, /技能 \d+ 个/);
  const worker = await cli(["worker", "--host", "cursor", "--project", root, "--human"]);
  assert.match(worker.text, /当前不可用/); assert.match(worker.text, /配置 reviewer/);
  const sync = await cli(["sync", "--host", "codex", "--project", root, "--dry-run", "--human"]);
  assert.match(sync.text, /变更预览/); assert.match(sync.text, /导出 0 个/);
});
test("protocol commands reject human output before opening a runtime or reading stdin", async t => {
  const root = await fixture(t);
  for (const command of ["hook", "serve"]) await assert.rejects(cli([command, "--host", "cursor", "--project", root, "--human"]), /protocol/);
  assert.deepEqual(await fs.readdir(root), []);
});

test("human repair previews quote shell metacharacters as literal project paths", async t => {
  const root = path.join(await fixture(t), "project's $(literal) ` dollar$"); await fs.mkdir(root);
  await cli(["install", "--host", "cursor", "--project", root]);
  await fs.unlink(path.join(root, ".cursor", "mcp.json"));
  const result = await cli(["doctor", "--host", "cursor", "--project", root, "--binary", process.execPath, "--human"]);
  const projectArg = `'${root.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  assert.ok(result.text.includes(`--project ${projectArg} --dry-run`));
});
