import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readOptions } from "../dist/config.js";
import { collectTasks, assessComplexity } from "../dist/tasks.js";
import type { TaskSnapshot } from "../src/types.ts";

const corpus = JSON.parse(await fs.readFile("evaluation/complexity.json", "utf8"));

test("labeled evidence distinguishes substantive work from call count, retries and routine repetition", () => {
  assert.equal(corpus.cases.length, 13);
  assert.equal(corpus.cases.filter((item: any) => item.expected === "accept").length, 5);
  for (const item of corpus.cases) {
    const options = readOptions(item.options ?? {});
    const snapshot: TaskSnapshot = { directory: process.cwd(), ...item.snapshot };
    const observed = collectTasks(snapshot, options, process.cwd()).some(packet => packet.eligible && assessComplexity(packet.snapshot, options).eligible);
    assert.equal(observed, item.expected === "accept", `${item.id}: ${item.rationale}`);
  }
});

test("legacy call-count options cannot promote labeled routine tasks to complex candidates", () => {
  const options = readOptions({ minToolCalls: 1, minToolCallsWithErrors: 1 });
  for (const item of corpus.cases.filter((item: any) => item.expected === "reject")) {
    const snapshot: TaskSnapshot = { directory: process.cwd(), ...item.snapshot };
    const observed = collectTasks(snapshot, options, process.cwd()).some(packet => packet.eligible && assessComplexity(packet.snapshot, options).eligible);
    assert.equal(observed, false, item.id);
  }
});
