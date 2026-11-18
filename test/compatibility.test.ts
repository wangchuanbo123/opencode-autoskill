import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SkillStore } from "../dist/skills.js";
import { ReuseEngine } from "../dist/reuse.js";
import { readOptions } from "../dist/config.js";
import { parseDecision } from "../dist/review.js";
import type { EnginePort, SkillCompatibility, SkillContent } from "../src/types.ts";
import { withAssessment } from "./helpers/assessment.ts";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-compatibility-"));
  const engines: ReuseEngine[] = [];
  t.after(async () => {
    await Promise.all(engines.map(engine => engine.close()));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("autoskill-compatibility-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const store = new SkillStore(root);
  const skill = (compatibility?: SkillCompatibility): SkillContent => ({ id: "migration-lock-method", name: "Migration database lock retry", description: "Recover transient database schema migration locks with bounded retry and a deadline.",
    whenToUse: ["A database schema migration has a transient lock"], prerequisites: [], steps: ["GUARDED_BODY: diagnose the transient lock and its owning transaction.", "Bound retry backoff and run the independent deadline regression."],
    pitfalls: ["Permanent schema errors must not be retried."], verification: ["Run the independent migration lock and deadline regression."], ...(compatibility ? { compatibility } : {}) });
  const save = async (content: SkillContent) => store.save({ action: "create", reason: "A verified reusable method", taskCompleted: true, reusable: true, confidence: 0.99, skill: content },
    { sessionId: "source", fingerprint: "fixture", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  const create = (host?: string, capabilities?: string[]) => {
    const port: EnginePort = { root, hostId: host, workspaceId: host ? "workspace" : undefined, hostCapabilities: capabilities,
      snapshot: async () => { throw new Error("No transcript needed for retrieval"); }, generate: async () => { throw new Error("Retrieval cannot call a model"); },
      listSkills: async () => store.list(), reloadSkills: async () => {}, log() {} };
    const engine = new ReuseEngine(root, readOptions({ reuseAutoLoadLimit: 0 }), port); engines.push(engine); return { engine, port };
  };
  const prepare = async (engine: ReuseEngine) => { await engine.prepare({ sessionId: "session", messageId: "user", text: "Recover transient database schema migration lock using bounded retry deadline" }); return engine.context("session", undefined, "user"); };
  return { root, store, skill, save, create, prepare };
}

test("compatibility metadata round trips in the owned hash and manual edits remain protected", async (t) => {
  const f = await fixture(t);
  const saved = await f.save(f.skill({ hosts: ["opencode"], requiredCapabilities: ["opencode.session.context"] }));
  const inspected = await f.store.inspect("migration-lock-method");
  assert.deepEqual(inspected.skill.compatibility, { hosts: ["opencode"], requiredCapabilities: ["opencode.session.context"] });
  assert.equal(inspected.skill.ownership, "managed");
  assert.equal(inspected.provenance.skillSha256, saved.sha256);
  const body = await fs.readFile(saved.path, "utf8");
  assert.match(body, /autoskill-compatibility/);
  await fs.writeFile(saved.path, body.replace('"hosts":["opencode"]', '"hosts":["codex"]'));
  assert.equal((await f.store.inspect("migration-lock-method")).skill.ownership, "user-modified");
  await assert.rejects(f.store.save({ action: "update", reason: "fixture", taskCompleted: true, reusable: true, confidence: 0.99, skill: f.skill() },
    { sessionId: "update", fingerprint: "fixture", messageIds: [], evidence: [], createdAt: new Date().toISOString() }, { expectedPreviousHash: saved.sha256 }), /manual changes|changed|untrusted/i);
  assert.match(await fs.readFile(saved.path, "utf8"), /"codex"/);
});

test("a host-specific method cannot be shortlisted, searched or explicitly loaded on another host", async (t) => {
  const f = await fixture(t); await f.save(f.skill({ hosts: ["opencode"] }));
  const incompatible = f.create("codex");
  assert.deepEqual((await f.prepare(incompatible.engine))!.candidateIds, []);
  const searched = await incompatible.engine.search({ sessionId: "session", query: "Database schema migration lock retry deadline" }) as any;
  assert.ok(!searched.candidates.some((candidate: any) => candidate.id === "migration-lock-method"));
  assert.notEqual((await incompatible.engine.load({ sessionId: "session", skillId: "migration-lock-method" }) as any).status, "loaded");
  assert.ok((await incompatible.engine.status() as any).compatibilityExcluded.some((item: any) => item.reasonCodes.includes("host_incompatible")));
  const unknown = f.create(); assert.deepEqual((await f.prepare(unknown.engine))!.candidateIds, []);
  const supported = f.create("opencode"); assert.ok((await f.prepare(supported.engine))!.candidateIds.includes("migration-lock-method"));
  assert.equal((await supported.engine.load({ sessionId: "session", skillId: "migration-lock-method" }) as any).status, "loaded");
});

test("required capabilities need adapter proof and are checked again after capability revocation", async (t) => {
  const f = await fixture(t); await f.save(f.skill({ hosts: ["opencode"], requiredCapabilities: ["opencode.session.context"] }));
  const missing = f.create("opencode"); assert.deepEqual((await f.prepare(missing.engine))!.candidateIds, []);
  assert.doesNotMatch((await missing.engine.context("session", undefined, "user"))!.text, /GUARDED_BODY/);
  const supported = f.create("opencode", ["opencode.session.context"]); await f.prepare(supported.engine);
  assert.equal((await supported.engine.load({ sessionId: "session", skillId: "migration-lock-method" }) as any).status, "loaded");
  supported.port.hostCapabilities = [];
  assert.notEqual((await supported.engine.load({ sessionId: "session", skillId: "migration-lock-method" }) as any).status, "loaded");
  assert.doesNotMatch((await supported.engine.context("session", undefined, "user"))!.text, /GUARDED_BODY/);
});

test("native plugin APIs acquire conservative host restrictions while ordinary commands remain portable", async (t) => {
  const f = await fixture(t), native = f.skill();
  native.steps = ["Register ctx.session.hook to attach task-scoped context.", "Call ctx.experimental.generate.text for a stateless review and validate evidence."];
  await f.save(native);
  assert.deepEqual((await f.store.inspect(native.id)).skill.compatibility, { hosts: ["opencode"] });
  const ordinary = { ...f.skill(), id: "ordinary-cli-method", name: "Ordinary CLI method", description: "Run an installed command in a project shell.", steps: ["Run opencode run through the project shell with the intended workspace.", "Inspect the result and independently verify generated files."] };
  await f.save(ordinary);
  assert.equal((await f.store.inspect(ordinary.id)).skill.compatibility, undefined);
  await assert.rejects(f.save({ ...native, id: "invalid-native-host", compatibility: { hosts: ["codex"] } }), /opencode-only/);
});

test("review output validates compatibility and preserves explicit native API requirements", async (t) => {
  const f = await fixture(t);
  const procedure = "Root cause: a transient database migration lock requires bounded retries after identifying its owning transaction.";
  const checked = "Independent migration lock regression: 12 tests passed and verified the deadline.";
  const evidence = new Map([
    ["procedure", { id: "procedure", name: "shell", status: "completed" as const, output: procedure }],
    ["check", { id: "check", name: "shell", status: "completed" as const, output: checked }],
  ]);
  const decision = withAssessment({ action: "create", reason: "A verified method", taskCompleted: true, reusable: true, confidence: 0.96, skill: f.skill({ hosts: ["codex"], requiredCapabilities: ["terminal"] }),
    evidence: [{ toolCallId: "procedure", excerpt: procedure, supports: "procedure" }, { toolCallId: "check", excerpt: checked, supports: "verification" }] });
  assert.deepEqual(parseDecision(JSON.stringify(decision), evidence, [], readOptions(), f.root).skill.compatibility, { hosts: ["codex"], requiredCapabilities: ["terminal"] });
  decision.skill.compatibility = { hosts: ["unknown-host"] };
  assert.throws(() => parseDecision(JSON.stringify(decision), evidence, [], readOptions(), f.root), /compatibility hosts/);
  decision.skill.compatibility = { requiredCapabilities: ["unbounded capability\ntext"] };
  assert.throws(() => parseDecision(JSON.stringify(decision), evidence, [], readOptions(), f.root), /required capabilities/);
  decision.skill.compatibility = undefined; decision.skill.steps[0] = "Register ctx.session.hook for the current task and verify the result.";
  assert.deepEqual(parseDecision(JSON.stringify(decision), evidence, [], readOptions(), f.root).skill.compatibility, { hosts: ["opencode"] });
});
