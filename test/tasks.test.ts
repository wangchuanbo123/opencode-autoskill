import test from "node:test";
import assert from "node:assert/strict";
import { collectTasks, assessComplexity } from "../dist/tasks.js";
import { selectRelevantSkills } from "../dist/review.js";
import { readOptions } from "../dist/config.js";
import type { ExistingSkill, TaskSnapshot } from "../src/types.ts";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { sessionId: "s", directory: process.cwd(), terminal: "success", messages: [
    { id: "u", role: "user", text: "分析迁移锁并验证修复", tools: [] },
    { id: "a", role: "assistant", text: "完成", tools: [
      { id: "t1", name: "shell", status: "completed", output: "Observed transient lock." },
      { id: "t2", name: "test", status: "completed", output: "12 tests passed and verified." },
    ] },
  ], ...overrides };
}

test("compaction preserves surviving task IDs and never attaches orphan evidence to a new goal", () => {
  const first = snapshot().messages;
  const second = first.map(message => ({ ...structuredClone(message), id: `${message.id}-new`, tools: message.tools.map(tool => ({ ...tool, id: `${tool.id}-new` })) }));
  const options = readOptions();
  const full = collectTasks(snapshot({ messages: [...first, ...second] }), options, process.cwd());
  const compacted = collectTasks(snapshot({ messages: [first[1]!, ...second] }), options, process.cwd());
  assert.equal(compacted.length, 1); assert.equal(compacted[0]!.id, full[1]!.id);
  assert.deepEqual(compacted[0]!.coverage, ["t1-new", "t2-new"]);
  assert.equal(collectTasks(snapshot({ messages: [first[1]!] }), options, process.cwd()).length, 0);
});

test("packet identity changes when terminal outcome changes and covers every tool", () => {
  const options = readOptions({ minToolCalls: 1, minComplexityScore: 1 });
  const failed = collectTasks(snapshot({ terminal: "failure" }), options, process.cwd())[0]!;
  const success = collectTasks(snapshot(), options, process.cwd())[0]!;
  assert.notEqual(failed.id, success.id);
  assert.equal(failed.eligible, false);
  assert.equal(success.eligible, true);
  assert.deepEqual(success.coverage, ["t1", "t2"]);
});

test("custom sensitive literals redact text and make the complete task ineligible", () => {
  const options = readOptions({ minToolCalls: 1, sensitivePatterns: ["InternalProjectName"] });
  const packets = collectTasks(snapshot({ messages: [
    { id: "u", role: "user", text: "分析 InternalProjectName 的部署", tools: [] },
    { id: "a", role: "assistant", text: "done", tools: [{ id: "t", name: "shell", status: "completed", output: "safe" }] },
  ] }), options, process.cwd());
  assert.equal(packets[0]!.eligible, false);
  assert.equal(packets[0]!.reasonCode, "sensitive_content");
  assert.doesNotMatch(packets[0]!.snapshot.messages[0]!.text, /InternalProjectName/);
});

test("continuation closes pending tools and retains the prior evidence in one task", () => {
  const options = readOptions({ minToolCalls: 1 });
  const packets = collectTasks(snapshot({ messages: [
    { id: "u", role: "user", text: "开始处理", tools: [] },
    { id: "a", role: "assistant", text: "执行中", tools: [{ id: "pending", name: "shell", status: "pending", output: "" }] },
    { id: "u2", role: "user", text: "继续完成", tools: [] },
    { id: "a2", role: "assistant", text: "已完成", tools: [{ id: "done", name: "test", status: "completed", output: "passed" }] },
  ] }), options, process.cwd());
  assert.equal(packets.length, 1);
  assert.equal(packets[0]!.eligible, true);
  assert.equal(packets[0]!.snapshot.messages[1]!.tools[0]!.status, "error");
});

test("codemode complexity counts bounded awaited calls", () => {
  const options = readOptions({ minToolCalls: 5, minToolCallsWithErrors: 5 });
  const value = snapshot({ messages: [{ id: "u", role: "user", text: "实现并验证", tools: [] }, { id: "a", role: "assistant", text: "", tools: [
    { id: "code", name: "codemode", status: "completed", input: "await tools.read(); await mcp.run(); await helper();", output: "tests passed" },
  ] }] });
  assert.ok(assessComplexity(value, options).logicalSteps >= 3);
});

test("Chinese query retrieval uses title and verification terms", () => {
  const skills: ExistingSkill[] = [
    { id: "a", name: "无关", title: "无关", description: "普通日志", path: "a", managed: true },
    { id: "b", name: "锁重试", title: "数据库锁重试", description: "迁移失败时使用", path: "b", managed: true },
  ];
  const selected = selectRelevantSkills(snapshot(), skills, 1);
  assert.equal(selected[0]!.id, "b");
});

