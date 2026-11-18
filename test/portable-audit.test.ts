import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeHook } from "../dist/adapters/events.js";
import { EventStore } from "../dist/portable/event-store.js";
import { readOptions } from "../dist/config.js";
import { PortableRuntime, runRuntimeCommand } from "../dist/portable/runtime.js";
import { SkillStore } from "../dist/skills.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autoskill-audit-"));
  await fs.mkdir(path.join(root, ".autoskill"));
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), "{}\n");
  const store = new EventStore(root, readOptions());
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store };
}

test("replayed task-start after completion preserves its existing evidence and token", async (t) => {
  const { root, store } = await fixture(t);
  const base = { session_id: "replay-session", turn_id: "same-turn", cwd: root };
  const start = normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Investigate the module target" });
  const first = await store.accept(start);
  await store.accept(normalizeHook("codex", { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "read-target", tool_input: { file_path: "tsconfig.json" }, tool_response: "Module target is ESNext" }));
  await store.accept(normalizeHook("codex", { ...base, hook_event_name: "Stop", last_assistant_message: "Investigated module target" }));
  const replay = await store.accept(start);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.task.contextToken, first.task.contextToken);
  assert.equal(replay.task.ended, true);
  assert.equal(replay.task.snapshot.messages.flatMap(message => message.tools).length, 1);
  assert.ok(await store.token(replay.task.contextToken, "codex"));
});

test("a delayed Stop cannot turn an interrupted execution into completed evidence", async (t) => {
  const { root, store } = await fixture(t);
  const base = { session_id: "cancel-session", turn_id: "cancel-turn", cwd: root };
  await store.accept(normalizeHook("codex", { ...base, hook_event_name: "UserPromptSubmit", prompt: "Repair the module target" }));
  await store.accept(normalizeHook("codex", { ...base, hook_event_name: "Interrupt" }));
  const delayedStop = await store.accept(normalizeHook("codex", { ...base, hook_event_name: "Stop", last_assistant_message: "Partial investigation complete" }));
  assert.equal(delayedStop.task.snapshot.terminal, "interrupted");
  assert.equal(delayedStop.task.snapshot.executionCompleted, false);
});

test("tool cwd inside the installed workspace is accepted while outside cwd is rejected", async (t) => {
  const { root, store } = await fixture(t);
  const nested = path.join(root, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  const base = { conversation_id: "nested-cursor", generation_id: "generation", workspace_roots: [root], cwd: root };
  await store.accept(normalizeHook("cursor", { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Investigate the nested package configuration" }));
  const inside = await store.accept(normalizeHook("cursor", { ...base, cwd: nested, hook_event_name: "postToolUse", tool_use_id: "nested-read", tool_name: "Read", tool_input: { file_path: "package.json" }, tool_output: '{"text":"The nested package uses ESNext"}' }));
  assert.ok(inside.task, "nested working directories belong to the same installed workspace");
  assert.equal(inside.task.snapshot.messages.flatMap(message => message.tools).length, 1);
  const outside = await store.accept(normalizeHook("cursor", { ...base, cwd: os.tmpdir(), hook_event_name: "postToolUse", tool_use_id: "outside-read", tool_name: "Read", tool_input: { file_path: "package.json" }, tool_output: "unrelated" }));
  assert.equal(outside.reasonCode, "project_out_of_scope");
});

test("task input truncation remains visible in persisted coverage", async (t) => {
  const { root, store } = await fixture(t);
  const start = normalizeHook("codex", { session_id: "long-prompt", turn_id: "turn", cwd: root, hook_event_name: "UserPromptSubmit", prompt: "x".repeat(70_000) + " Do not use any skills." });
  assert.ok(start.coverage.reasons.includes("prompt_truncated"));
  const captured = await store.accept(start);
  assert.ok(captured.task.coverage.includes("prompt_truncated"), "truncation must survive process restart instead of restoring an apparently complete request");
});

test("MCP refinement after a process restart preserves topic exclusions for newly learned skills", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, ".autoskill", "config.json"), JSON.stringify({ schemaVersion: 1, adapters: { codex: { enabled: true } }, options: {}, agentPolicy: "root-only" }));
  await runRuntimeCommand({ command: "hook", host: "codex", root, event: "UserPromptSubmit", input: { session_id: "excluded-topic", turn_id: "turn", cwd: root, prompt: "Do not use tenant invoice cache; investigate database migration lock retry" } });
  const corpus = JSON.parse(await fs.readFile(new URL("../evaluation/reuse.json", import.meta.url), "utf8"));
  const data = corpus.skills.find(skill => skill.id === "tenant-invoice-cache");
  await new SkillStore(root).save({ action: "create", reason: "Trusted test fixture", taskCompleted: true, reusable: true, confidence: 0.99,
    skill: { ...data, pitfalls: [], verification: ["Run an independent targeted regression."] } },
    { sessionId: "source", fingerprint: "source-new-topic", messageIds: [], evidence: [], createdAt: new Date().toISOString() });
  const reopened = await PortableRuntime.open(root, "codex");
  try {
    const task = await reopened.events.current("codex", "excluded-topic");
    assert.ok(task);
    const result = await reopened.search("tenant invoice cache collision isolation", task.contextToken);
    assert.ok(!result.candidates?.some(skill => skill.id === "tenant-invoice-cache"), "a different process must retain the original task's excluded topic for new skills");
  } finally { await reopened.close(); }
});
