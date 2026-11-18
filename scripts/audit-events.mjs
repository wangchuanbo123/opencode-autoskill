import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventStore } from '../dist/portable/event-store.js';
import { readOptions } from '../dist/config.js';
import { normalizeHook } from '../dist/adapters/events.js';
import { PortableRuntime } from '../dist/portable/runtime.js';
import { installHost } from '../dist/portable/install.js';
import { cleanEvidence } from '../dist/maintenance.js';

const output = {};
const tempBase = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(tempBase, 'autoskill-event-review-'));
let one, two, runtime;
try {
  await installHost({root, host: 'generic'});
  const base = {session_id: 'native-session', cwd: root};
  one = new EventStore(root, readOptions());
  two = new EventStore(root, readOptions());
  const a = await one.accept(normalizeHook('gemini', {...base, hook_event_name: 'BeforeAgent', prompt: 'First request: investigate invoice cache'}));
  await one.accept(normalizeHook('gemini', {...base, hook_event_name: 'AfterAgent', prompt_response: 'First response'}));
  await delay(10);
  const b = await one.accept(normalizeHook('gemini', {...base, hook_event_name: 'BeforeAgent', prompt: 'Second request: inspect database migration'}));
  await delay(10);
  await two.captured(a.task.id);
  const tool = await one.accept(normalizeHook('gemini', {...base, hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: {file_path:'migration.sql'}}));
  const stopped = await one.accept(normalizeHook('gemini', {...base, hook_event_name:'AfterAgent', prompt_response:'Second response'}));
  output.updatedOrder = {
    a: a.task.id, b: b.task.id, toolAssociatedTask: tool.task?.id, toolReason: tool.reasonCode,
    stoppedTask: stopped.task?.id, secondTaskEnded: (await one.get(b.task.id)).ended,
    actualCurrent: (await one.current('gemini', 'native-session')).id,
  };
  const replayBase={session_id:'long-session',cwd:root,hook_event_name:'UserPromptSubmit'};
  const originalInput={...replayBase,turn_id:'turn-0',prompt:'First of many prompts'};
  const original=await one.accept(normalizeHook('codex',originalInput));
  await one.accept(normalizeHook('codex',{...replayBase,turn_id:'turn-0',hook_event_name:'PostToolUse',tool_name:'Read',tool_use_id:'original-tool',tool_input:{file_path:'one'},tool_response:'original-evidence'}));
  await one.accept(normalizeHook('codex',{...replayBase,turn_id:'turn-0',hook_event_name:'Stop',last_assistant_message:'original-finished'}));
  for(let i=1;i<=13;i++) {
    await delay(2);
    await one.accept(normalizeHook('codex',{...replayBase,turn_id:'turn-'+i,prompt:'Prompt '+i}));
    await one.accept(normalizeHook('codex',{...replayBase,turn_id:'turn-'+i,hook_event_name:'Stop',last_assistant_message:'finished '+i}));
  }
  const replay=await one.accept(normalizeHook('codex',originalInput));
  output.oldStartReplay={originalId:original.task.id,newId:replay.task.id,originalToken:original.task.contextToken,newToken:replay.task.contextToken,
    newTokenResolvable:!!await one.token(replay.task.contextToken,'codex'),oldTokenResolvable:!!await one.token(original.task.contextToken,'codex'),
    evidenceTools:replay.task.snapshot.messages.flatMap(m=>m.tools).length,ended:replay.task.ended,duplicate:replay.duplicate??false};
  await one.close(); one=undefined; await two.close(); two=undefined;

  const file = path.join(root,'.autoskill/config.json');
  const config=JSON.parse(await fs.readFile(file,'utf8'));
  config.options={globalStateDirectory:path.join(root,'private-global')};
  await fs.writeFile(file,JSON.stringify(config));
  runtime=await PortableRuntime.open(root,'generic');
  for(let i=0;i<3;i++) await runtime.search('database migration inspection '+i);
  const before=await runtime.events.status();
  await delay(10);
  const cleaning=await cleanEvidence(root,{olderThanDays:0});
  const after=await runtime.events.status();
  output.explicitRetention={before,cleaning,after};
  output.acceptance = {
    activeTaskPreserved: output.updatedOrder.toolAssociatedTask === b.task.id && output.updatedOrder.stoppedTask === b.task.id && output.updatedOrder.secondTaskEnded && output.updatedOrder.actualCurrent === b.task.id,
    oldStartDeduplicated: output.oldStartReplay.duplicate && output.oldStartReplay.evidenceTools === 1 && output.oldStartReplay.ended && output.oldStartReplay.originalToken === output.oldStartReplay.newToken && output.oldStartReplay.newTokenResolvable,
    explicitQueriesCleaned: before.hosts.find(item => item.host === 'generic')?.tasks === 3 && (after.hosts.find(item => item.host === 'generic')?.tasks ?? 0) === 0 && cleaning.eventTasks >= 3,
  };
  console.log(JSON.stringify(output,null,2));
  assert.ok(Object.values(output.acceptance).every(Boolean), 'Event lifecycle acceptance failed; inspect JSON details.');
} finally {
  await one?.close(); await two?.close(); await runtime?.close();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('autoskill-event-review-') ||
      (await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('Unsafe audit temporary directory.');
  await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
}

