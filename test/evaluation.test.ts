import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

async function run(args: string[] = [], token?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/evaluate.mjs", ...args], { cwd: process.cwd(), env: { ...process.env, ...(token ? { AUTOSKILL_EVAL_TOKEN: token } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
  });
}

test("offline evaluation passes without network and rejects unknown/missing arguments", async () => {
  const offline = await run();
  assert.equal(offline.code, 0, offline.output);
  const report = JSON.parse(offline.output);
  assert.equal(report.mode, "candidate-gates");
  assert.equal(report.prescreen.total, 13);
  assert.equal(report.prescreen.passed, 13);
  assert.equal(report.prescreen.falseAccepts, 0);
  assert.equal(report.prescreen.falseRejects, 0);
  assert.ok(report.prescreen.results.every((item: any) => item.rationale && Array.isArray(item.assessments)));
  assert.equal(report.reuse.total, 11);
  assert.equal(report.reuse.passed, 11);
  assert.equal(report.reuse.falseAutoLoads, 0);
  assert.equal(report.reuse.missedAutoLoads, 0);
  assert.equal(report.reuse.candidateRecall, 1);
  assert.ok(report.reuse.results.every((item: any) => item.rationale && Array.isArray(item.candidates)));
  assert.notEqual((await run(["--unknown"])).code, 0);
  assert.notEqual((await run(["--responses"])).code, 0);
});

test("response replay requires every decision case instead of mixing canned responses", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-eval-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "responses.json"); await fs.writeFile(file, "{}");
  const result = await run(["--responses", file]);
  assert.notEqual(result.code, 0); assert.match(result.output, /missing decision case/);
});

test("explicit endpoint sends all decision cases with token, prompt, and evidence; HTTP errors fail", async (t) => {
  const corpus = JSON.parse(await fs.readFile("evaluation/corpus.json", "utf8"));
  const base = corpus.cases.find((item: any) => item.response)?.response;
  const seen: string[] = []; let fail = false;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer local-stub-token");
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); assert.equal(typeof input.prompt, "string"); assert.ok(Array.isArray(input.evidence)); seen.push(input.id);
    if (fail) { response.statusCode = 503; response.end("unavailable"); return; }
    const output = structuredClone(base);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ output }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number }; const endpoint = `http://127.0.0.1:${address.port}`;
  const success = await run(["--endpoint", endpoint], "local-stub-token");
  assert.equal(success.code, 0, success.output); assert.equal(seen.length, 3);
  assert.equal(JSON.parse(success.output).reuse.passed, 11); // Reuse routing must stay local, without extra reviewer requests.
  fail = true;
  const broken = await run(["--endpoint", endpoint], "local-stub-token");
  assert.notEqual(broken.code, 0); assert.match(broken.output, /reviewer_source_error/);
});

