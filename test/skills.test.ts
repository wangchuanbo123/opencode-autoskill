import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { SkillStore } from "../dist/skills.js";
import type { ReviewDecision, ReviewProvenance } from "../src/types.ts";

async function project(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-store-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function decision(id = "database-retry", action: "create" | "update" = "create"): ReviewDecision {
  return { action, reason: "Verified reusable technique", taskCompleted: true, reusable: true, confidence: 0.95,
    skill: { id, name: "Database retry", description: "Use when transient database locks interrupt a migration.",
      whenToUse: ["A migration fails with a transient database lock."], prerequisites: ["A migration test fixture exists."],
      steps: ["Capture the original lock error.", "Retry with bounded exponential backoff."],
      pitfalls: ["Keep permanent schema errors visible."], verification: ["Run the lock contention regression test."] },
    evidence: [{ toolCallId: "tool-1", supports: "verification", excerpt: "lock contention test passed" }] };
}

const provenance: ReviewProvenance = { sessionId: "session-1", fingerprint: "f00d", messageIds: ["message-1"],
  evidence: [{ toolCallId: "tool-1", supports: "verification", excerpt: "lock contention test passed" }], createdAt: "2026-11-13T00:00:00.000Z" };

async function saveUpdate(store: SkillStore, candidate: ReviewDecision, source = provenance) {
  const current = (await store.list()).find((entry) => entry.id === candidate.skill!.id);
  return store.save(candidate, source, { expectedPreviousHash: current?.sha256 });
}

function sourceFile(root: string, id = "database-retry") { return path.join(root, ".opencode", "autoskill", "provenance", id, "SOURCE.json"); }

test("creates discoverable Skill with valid quoted YAML and evidence", async (t) => {
  const root = await project(t);
  const store = new SkillStore(root);
  const candidate = decision();
  candidate.skill!.name = 'Database: "retry"\ntechnique';
  candidate.skill!.description = "Use when: YAML contains # and --- markers.";
  const saved = await store.save(candidate, provenance);
  assert.equal(saved.changed, true);
  const content = await fs.readFile(saved.path, "utf8");
  const header = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(content)![1]!);
  assert.equal(header.name, candidate.skill!.id);
  assert.equal(header.description, candidate.skill!.description);
  assert.equal(header.metadata.autoskill, true);
  assert.match(content, /# Database: "retry" technique/);
  assert.match(content, /## Procedure/);
  assert.match(content, /## Verification/);
  const source = JSON.parse(await fs.readFile(sourceFile(root), "utf8"));
  assert.equal(source.sessionId, "session-1");
  assert.equal(source.skillSha256.length, 64);
  const entries = await store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.managed, true);
  assert.equal(entries[0]!.contentComplete, true);
  assert.equal(entries[0]!.name, 'Database: "retry" technique');
  await assert.rejects(fs.access(path.join(path.dirname(saved.path), "SOURCE.json")));
});

test("idempotent writes do not create backups; changed updates retain old evidence outside discovery", async (t) => {
  const root = await project(t);
  const store = new SkillStore(root);
  const original = await store.save(decision(), provenance);
  assert.equal((await store.save(decision(), { ...provenance, fingerprint: "different" })).changed, false);
  const next = decision("database-retry", "update");
  next.skill!.steps.push("Stop after the configured retry budget.");
  await saveUpdate(store, next, { ...provenance, fingerprint: "updated" });
  const backups = await fs.readdir(path.join(root, ".opencode", "autoskill", "backups", "database-retry"));
  assert.equal(backups.filter((name) => name.endsWith(".SKILL.md")).length, 1);
  assert.equal(backups.filter((name) => name.endsWith(".SOURCE.json")).length, 1);
  const backup = await fs.readFile(path.join(root, ".opencode", "autoskill", "backups", "database-retry", backups.find((name) => name.endsWith(".SKILL.md"))!), "utf8");
  assert.doesNotMatch(backup, /Stop after/);
  assert.match(await fs.readFile(original.path, "utf8"), /Stop after/);
  assert.equal((await store.list()).length, 1);
});

test("refuses to overwrite user skills or update missing skills", async (t) => {
  const root = await project(t);
  const directory = path.join(root, ".opencode", "skills", "database-retry");
  await fs.mkdir(directory, { recursive: true });
  const userContent = "---\nname: User skill\ndescription: User-authored workflow\n---\nKeep this.\n";
  await fs.writeFile(path.join(directory, "SKILL.md"), userContent);
  const store = new SkillStore(root);
  await assert.rejects(store.save(decision("database-retry", "update"), provenance), /user-owned/);
  assert.equal(await fs.readFile(path.join(directory, "SKILL.md"), "utf8"), userContent);
  await assert.rejects(store.save(decision("missing-skill", "update"), provenance), /does not exist/);
  assert.equal((await store.list())[0]!.managed, false);
});

test("rejects traversal, absolute ids and Windows device names", async (t) => {
  const root = await project(t);
  const store = new SkillStore(root);
  for (const id of ["../outside", "a/b", "a\\b", "C:\\outside", "CON", "con", "nul", "com1", "lpt9", "-bad", "a".repeat(65)]) {
    await assert.rejects(store.save(decision(id), provenance), /portable lowercase/);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("refuses symbolic-link and junction escapes at the storage ancestor and skill directory", async (t) => {
  const root = await project(t);
  const outside = await project(t);
  await fs.symlink(outside, path.join(root, ".opencode"), process.platform === "win32" ? "junction" : "dir");
  const store = new SkillStore(root);
  await assert.rejects(store.save(decision(), provenance), /Symbolic links/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, ".opencode"));
  await fs.mkdir(path.join(root, ".opencode", "skills"), { recursive: true });
  await fs.symlink(outside, path.join(root, ".opencode", "skills", "database-retry"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.save(decision(), provenance), /Symbolic links/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("parallel writers serialize and do not lose or corrupt a skill", async (t) => {
  const root = await project(t);
  const one = new SkillStore(root);
  const two = new SkillStore(root);
  const results = await Promise.all([one.save(decision(), provenance), two.save(decision(), provenance)]);
  assert.equal(results.filter((result) => result.changed).length, 1);
  assert.equal((await one.list()).length, 1);
  assert.ok(!(await fs.readdir(path.join(root, ".opencode", "autoskill", "locks"))).some((name) => name.endsWith(".tmp")));
  const changes = [decision("database-retry", "update"), decision("database-retry", "update")];
  changes[0]!.skill!.steps.push("Version A.");
  changes[1]!.skill!.steps.push("Version B.");
  const baseline = (await one.list())[0]!.sha256;
  const writes = await Promise.allSettled(changes.map((change) => new SkillStore(root).save(change, provenance, { expectedPreviousHash: baseline })));
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const body = await fs.readFile(results[0]!.path, "utf8");
  assert.match(body, /Version [AB]/);
  assert.equal((await fs.readdir(path.dirname(results[0]!.path))).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("backup retention keeps ten prior versions", async (t) => {
  const root = await project(t);
  const store = new SkillStore(root);
  await store.save(decision(), provenance);
  for (let i = 0; i < 12; i++) {
    const change = decision("database-retry", "update");
    change.skill!.steps.push(`Revision ${i}.`);
    await saveUpdate(store, change);
  }
  const files = await fs.readdir(path.join(root, ".opencode", "autoskill", "backups", "database-retry"));
  assert.equal(files.filter((file) => file.endsWith(".SKILL.md")).length, 10);
  assert.equal(files.filter((file) => file.endsWith(".SOURCE.json")).length, 10);
});

test("discovery indexes all skills, includes nested user skills, skips supporting children", async (t) => {
  const root = await project(t);
  for (let i = 0; i < 55; i++) {
    const directory = path.join(root, ".opencode", "skills", "team", `skill-${String(i).padStart(2, "0")}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: User ${i}\ndescription: Existing workflow\n---\n${"body ".repeat(3_000)}`);
    const child = path.join(directory, "references", "hidden-skill");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(child, "SKILL.md"), "Should never be advertised separately");
  }
  const entries = await new SkillStore(root).list();
  assert.equal(entries.length, 55);
  assert.ok(entries.every((entry) => entry.content!.length <= 64_000));
  assert.ok(entries.every((entry) => entry.contentComplete === true));
  assert.ok(entries.every((entry) => entry.id !== "hidden-skill"));
});

test("oversized or non-file skill entries do not block discovery of usable skills", async (t) => {
  const root = await project(t);
  const skills = path.join(root, ".opencode", "skills");
  await fs.mkdir(path.join(skills, "a-invalid", "SKILL.md"), { recursive: true });
  await fs.mkdir(path.join(skills, "b-oversized"), { recursive: true });
  await fs.writeFile(path.join(skills, "b-oversized", "SKILL.md"), "x".repeat(256_001));
  await fs.writeFile(path.join(skills, "oversized.md"), "x".repeat(256_001));
  const store = new SkillStore(root);
  await store.save(decision(), provenance);
  const entries = await store.list();
  assert.deepEqual(entries.map((entry) => entry.id), ["database-retry"]);
});

test("contentComplete distinguishes full boundary-sized text from truncated managed and flat skills", async (t) => {
  const root = await project(t);
  const skills = path.join(root, ".opencode", "skills");
  const prefix = "---\nname: boundary\ndescription: Completeness boundary\nmetadata:\n  autoskill: true\n---\n";
  for (const [id, length] of [["complete", 64_000], ["incomplete", 64_001]] as const) {
    await fs.mkdir(path.join(skills, id), { recursive: true });
    await fs.writeFile(path.join(skills, id, "SKILL.md"), prefix + "x".repeat(length - prefix.length));
  }
  await fs.writeFile(path.join(skills, "flat.md"), "x".repeat(64_001));
  const entries = await new SkillStore(root).list();
  assert.equal(entries.find((entry) => entry.id === "complete")!.contentComplete, true);
  for (const id of ["incomplete", "flat"]) {
    const entry = entries.find((entry) => entry.id === id)!;
    assert.equal(entry.contentComplete, false);
    assert.equal(entry.content!.length, 64_000);
  }
  assert.equal(entries.find((entry) => entry.id === "incomplete")!.ownership, "user-modified");
});

test("manual edits and corrupt source hashes are protected until explicit adoption", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  const original = await store.save(decision(), provenance);
  await fs.appendFile(original.path, "\nHuman correction: never retry a permanent schema error.\n");
  const edited = (await store.list())[0]!;
  assert.equal(edited.managed, false);
  assert.equal(edited.ownership, "user-modified");
  await assert.rejects(store.save(decision("database-retry", "update"), provenance, { expectedPreviousHash: edited.sha256 }), /manual changes/);
  await assert.rejects(store.restore("database-retry"), /manual changes/);
  const adopted = await store.adopt("database-retry");
  assert.equal(adopted.ownership, "managed");
  assert.match(adopted.content!, /Human correction/);
  const source = JSON.parse(await fs.readFile(sourceFile(root), "utf8"));
  source.skillSha256 = "0".repeat(64);
  await fs.writeFile(sourceFile(root), JSON.stringify(source));
  assert.equal((await store.list())[0]!.ownership, "user-modified");
  await assert.rejects(saveUpdate(store, decision("database-retry", "update")), /untrusted provenance/);
});

test("optimistic concurrency rejects stale review baselines and missing expected hashes", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  const original = await store.save(decision(), provenance);
  const next = decision("database-retry", "update"); next.skill!.steps.push("Add a bounded retry budget.");
  await assert.rejects(store.save(next, provenance), /expectedPreviousHash/);
  await store.save(next, provenance, { expectedPreviousHash: original.sha256 });
  const stale = decision("database-retry", "update"); stale.skill!.steps.push("A stale review proposes another revision.");
  await assert.rejects(store.save(stale, provenance, { expectedPreviousHash: original.sha256 }), /changed since review/);
  assert.match((await store.list())[0]!.content!, /bounded retry budget/);
});

test("cancelled saves publish nothing and managed quotas prevent unbounded creation", async (t) => {
  const root = await project(t), store = new SkillStore(root), controller = new AbortController();
  controller.abort();
  await assert.rejects(store.save(decision(), provenance, { signal: controller.signal }));
  assert.deepEqual(await fs.readdir(root), []);
  await store.save(decision(), provenance, { maxManagedSkills: 1 });
  await assert.rejects(store.save(decision("second-workflow"), provenance, { maxManagedSkills: 1 }), /quota reached/);
  assert.equal((await store.list()).length, 1);
  assert.match(await fs.readFile(path.join(root, ".opencode/autoskill/.gitignore"), "utf8"), /^\*/m);
  const concurrentRoot = await project(t);
  const simultaneous = await Promise.allSettled(["workflow-a", "workflow-b"].map((id) => new SkillStore(concurrentRoot).save(decision(id), provenance, { maxManagedSkills: 1 })));
  assert.equal(simultaneous.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal((await new SkillStore(concurrentRoot).list()).length, 1);
});

test("pin, feedback, usage, rollback, archive, and restore form a consistent lifecycle", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  const original = await store.save(decision(), provenance);
  await store.pin("database-retry", true);
  const update = decision("database-retry", "update"); update.skill!.steps.push("New verified retry cap.");
  await assert.rejects(saveUpdate(store, update), /pinned/);
  await assert.rejects(store.archive("database-retry"), /unpinned/);
  await store.pin("database-retry", false);
  await saveUpdate(store, update);
  const inspected = await store.inspect("database-retry");
  assert.equal(inspected.versions.length, 1);
  assert.equal(inspected.versions[0], original.version);
  await store.recordUsage("database-retry");
  await store.feedback("database-retry", { outcome: "success", notes: "Successfully reused." });
  await store.feedback("database-retry", { outcome: "failure", notes: "password=should-not-persist" });
  const controls = (await store.list())[0]!;
  assert.equal(controls.usageCount, 1);
  assert.deepEqual(controls.feedback, { success: 1, failure: 1 });
  const privateControls = await fs.readFile(path.join(root, ".opencode/autoskill/provenance/database-retry/CONTROL.json"), "utf8");
  assert.doesNotMatch(privateControls, /should-not-persist/);
  const restored = await store.restore("database-retry", original.version);
  assert.doesNotMatch(restored.content!, /New verified retry cap/);
  assert.equal(restored.ownership, "managed");
  const archived = await store.archive("database-retry");
  assert.equal(archived.archived, true);
  await assert.rejects(fs.access(original.path));
  await assert.rejects(store.save(decision(), provenance), /archived/);
  assert.equal((await store.restore("database-retry")).archived, false);
  assert.equal((await store.list())[0]!.usageCount, 1);
});

test("legacy source evidence is migrated out of the shareable tree without changing Markdown", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  const saved = await store.save(decision(), provenance);
  const body = await fs.readFile(saved.path, "utf8");
  const legacy = path.join(path.dirname(saved.path), "SOURCE.json");
  const source = JSON.parse(await fs.readFile(sourceFile(root), "utf8"));
  delete source.version; source.schemaVersion = 1;
  await fs.writeFile(legacy, JSON.stringify(source)); await fs.unlink(sourceFile(root));
  const entries = await store.list();
  assert.equal(entries[0]!.ownership, "managed");
  assert.equal(await fs.readFile(saved.path, "utf8"), body);
  await assert.rejects(fs.access(legacy));
  assert.equal(JSON.parse(await fs.readFile(sourceFile(root), "utf8")).schemaVersion, 2);
});

test("publication recovery reconciles committed Markdown with its private source", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  const saved = await store.save(decision(), provenance);
  const source = JSON.parse(await fs.readFile(sourceFile(root), "utf8"));
  await fs.writeFile(path.join(root, ".opencode/autoskill/provenance/database-retry/PUBLISH.json"), JSON.stringify({ previousHash: "0".repeat(64), nextHash: saved.sha256, source }));
  await fs.unlink(sourceFile(root));
  assert.equal((await store.list())[0]!.ownership, "managed");
  assert.equal(JSON.parse(await fs.readFile(sourceFile(root), "utf8")).skillSha256, saved.sha256);
  await assert.rejects(fs.access(path.join(root, ".opencode/autoskill/provenance/database-retry/PUBLISH.json")));
});

test("adopting and archiving a flat skill never moves its containing skills directory", async (t) => {
  const root = await project(t), store = new SkillStore(root), directory = path.join(root, ".opencode/skills");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "flat.md"), "---\nname: Flat example\ndescription: A manual workflow\n---\n# Flat example\nKeep manually authored instructions.\n");
  await fs.writeFile(path.join(directory, "other.md"), "Other user skill");
  await store.adopt("flat");
  assert.equal((await store.archive("flat")).archived, true);
  assert.equal(await fs.readFile(path.join(directory, "other.md"), "utf8"), "Other user skill");
  assert.equal((await store.restore("flat")).archived, false);
  await fs.access(path.join(directory, "flat/SKILL.md"));
});

function beforeNextLock(store: SkillStore, operation: () => Promise<void>) {
  const mutable = store as unknown as { lock(id: string): Promise<() => Promise<void>> };
  const original = mutable.lock.bind(store);
  let pending = true;
  mutable.lock = async (id) => {
    if (pending) { pending = false; await operation(); }
    return original(id);
  };
}

test("archive rechecks pins, ownership, and location after waiting for its skill lock", async (t) => {
  for (const race of ["pin", "edit", "move"] as const) {
    const root = await project(t), store = new SkillStore(root), saved = await store.save(decision(), provenance);
    beforeNextLock(store, async () => {
      if (race === "pin") await store.pin("database-retry");
      if (race === "edit") await fs.appendFile(saved.path, "\nUser-authored addition while archive waited.\n");
      if (race === "move") await fs.rename(path.dirname(saved.path), path.join(root, "moved-by-user"));
    });
    await assert.rejects(store.archive("database-retry"), race === "pin" ? /pinned before archive/ : race === "edit" ? /changed before archive/ : /moved before archive/);
    if (race === "pin") assert.equal((await store.list())[0]!.pinned, true);
    if (race !== "move") assert.equal((await store.list())[0]!.archived, false);
    await assert.rejects(fs.access(path.join(root, ".opencode/autoskill/archives/database-retry")));
  }
});

test("rollback rechecks current provenance and adoption rejects a moved source", async (t) => {
  const root = await project(t), store = new SkillStore(root), first = await store.save(decision(), provenance);
  const update = decision("database-retry", "update"); update.skill!.steps.push("A new verified step.");
  await saveUpdate(store, update);
  const currentBody = await fs.readFile(first.path, "utf8");
  beforeNextLock(store, async () => { await fs.unlink(sourceFile(root)); });
  await assert.rejects(store.restore("database-retry", first.version), /changed before rollback/);
  assert.equal(await fs.readFile(first.path, "utf8"), currentBody);
  const secondRoot = await project(t), second = new SkillStore(secondRoot), saved = await second.save(decision(), provenance);
  beforeNextLock(second, async () => { await fs.rename(path.dirname(saved.path), path.join(secondRoot, "moved-by-user")); });
  await assert.rejects(second.adopt("database-retry"), /moved before adoption/);
});

test("publication checks its final guard before installing Markdown and rechecks edits afterward", async (t) => {
  const root = await project(t), store = new SkillStore(root);
  let guardCalls = 0;
  await assert.rejects(store.save(decision(), provenance, { beforeCommit: async () => {
    guardCalls++;
    const files = await fs.readdir(path.join(root, ".opencode/skills/database-retry"));
    assert.ok(files.some((name) => name.endsWith(".tmp")), "guard must run after preparing the new file");
    throw new Error("Review lease lost before publication");
  } }), /lease lost/);
  assert.equal(guardCalls, 1);
  await assert.rejects(fs.access(path.join(root, ".opencode/skills/database-retry/SKILL.md")));
  await assert.rejects(fs.access(path.join(root, ".opencode/autoskill/provenance/database-retry/PUBLISH.json")));
  const saved = await store.save(decision(), provenance);
  const update = decision("database-retry", "update"); update.skill!.steps.push("New candidate step.");
  await assert.rejects(store.save(update, provenance, { expectedPreviousHash: saved.sha256, beforeCommit: async () => {
    await fs.appendFile(saved.path, "\nA user edit made while the publication guard waited.\n");
  } }), /changed before commit/);
  assert.match(await fs.readFile(saved.path, "utf8"), /user edit/);
  assert.doesNotMatch(await fs.readFile(saved.path, "utf8"), /New candidate step/);
});
