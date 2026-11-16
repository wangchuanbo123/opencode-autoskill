import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { AutoSkillEngine } from "../engine.js";
import { SkillStore } from "../skills.js";
import { readOptions } from "../config.js";
import { redact } from "../safety.js";
import { acquireFileLock } from "../lock.js";
import { ensurePrivateDirectory } from "../state.js";
import { resolveStorageLayout } from "../storage-layout.js";
import { capabilitiesFor, normalizeHook, hookResponse } from "../adapters/events.js";
import { readPortableConfig } from "./install.js";
import { generateReview, reviewerStatus } from "./reviewer.js";
import { EventStore } from "./event-store.js";
export class PortableRuntime {
    root;
    host;
    config;
    events;
    engine;
    skills;
    backend;
    constructor(root, host, config, background, automaticReuse) {
        this.root = root;
        this.host = host;
        this.config = config;
        const options = readOptions({ ...config.options, agentPolicy: config.agentPolicy, reuseMaxContextChars: Math.min(Number(config.options.reuseMaxContextChars ?? 16_000), 8_000),
            ...(!automaticReuse ? { reuseAutoLoadLimit: 0 } : {}) });
        this.events = new EventStore(root, options);
        this.skills = new SkillStore(root);
        this.backend = reviewerStatus(config.reviewer);
        const port = { root, hostId: host, workspaceId: this.events.workspaceId,
            backgroundWorker: background && this.backend.available, options: { ...options, ...(config.reviewer ? { model: { providerID: "autoskill-reviewer", id: config.reviewer.model } } : {}) },
            capabilities: { supported: true, hostVersion: "portable-events-v1", missing: [] },
            reuseCapabilities: { supported: true, hostVersion: "portable-events-v1", missing: [] },
            snapshot: async (id) => { const task = await this.events.get(id); if (!task || task.host !== host)
                throw new Error("Task evidence unavailable."); return task.snapshot; },
            generate: (input) => generateReview(config.reviewer, input),
            listSkills: async () => this.skills.list(), reloadSkills: async () => { },
            log: (level, message) => { if (level !== "info")
                process.stderr.write(`[AutoSkill ${level}] ${redact(message, root)}\n`); } };
        this.engine = new AutoSkillEngine(port);
    }
    static async open(root, host, options = {}) {
        const resolved = await fs.realpath(path.resolve(root));
        const config = await readPortableConfig(resolved);
        if (!config.adapters[host]?.enabled)
            throw new Error(`AutoSkill adapter ${host} is not enabled; install it for this project first.`);
        return new PortableRuntime(resolved, host, config, options.background === true, options.automaticReuse === true);
    }
    async prepare(task, signal) {
        if (task.sensitive || task.coverage.includes("superseded_before_completion"))
            throw new Error("Task reuse is excluded by its privacy or revision policy.");
        await this.engine.prepareReuse({ sessionId: task.id, messageId: task.messageId, text: task.prompt, signal });
    }
    async context(task, signal) {
        await this.prepare(task, signal);
        const context = await this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash);
        return `AutoSkill task contextToken: ${task.contextToken}. Use this token with autoskill_search/load/feedback for this task only.\n${context?.text ?? "No relevant AutoSkill candidate was found for this task."}`;
    }
    async resolveTask(token) {
        if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token))
            throw new Error("A contextToken returned for this task is required.");
        const task = await this.events.token(token, this.host);
        if (!task || task.sensitive || task.coverage.includes("superseded_before_completion"))
            throw new Error("Task context is missing, superseded or excluded.");
        return task;
    }
    async search(query, token, signal) {
        if (!query.trim() || query.length > 1_500)
            throw new Error("query must contain 1–1500 characters.");
        const task = token ? await this.resolveTask(token) : await this.events.explicit(this.host, query);
        await this.prepare(task, signal);
        // Activate this exact task without attributing native task outcome to an explicit MCP query.
        await this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash);
        const result = await this.engine.searchReuse({ sessionId: task.id, query, signal });
        return { ...result, contextToken: task.contextToken, association: task.trusted ? "host-task" : "explicit-mcp-query" };
    }
    async load(skillId, token, signal) {
        const task = await this.resolveTask(token);
        await this.prepare(task, signal);
        await this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash);
        return this.engine.loadReuse({ sessionId: task.id, skillId, signal });
    }
    async feedback(input, signal) {
        const task = await this.resolveTask(input.contextToken);
        await this.prepare(task, signal);
        await this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash);
        return this.engine.reuseFeedback({ sessionId: task.id, skillId: input.skillId, used: input.used, outcome: input.outcome, signal });
    }
    async capturePending() {
        let captured = 0;
        for (const task of await this.events.pending(this.host)) {
            if (!task.trusted || task.coverage.includes("tool_count_budget") || task.sensitive) {
                await this.events.captured(task.id);
                continue;
            }
            const result = await this.engine.enqueue(task.id, task.snapshot.terminal);
            if (result.status !== "failed" && result.reasonCode !== "capture_unavailable") {
                await this.events.captured(task.id);
                captured++;
            }
        }
        return captured;
    }
    async review(token, dryRun = false, signal) {
        const task = await this.resolveTask(token);
        if (!task.trusted || !task.ended)
            return { status: "unavailable", reasonCode: "trusted_completed_evidence_required" };
        if (!this.backend.available)
            return { status: "unavailable", reasonCode: this.backend.reasonCode };
        return this.engine.review(task.id, false, signal, dryRun);
    }
    async status() {
        return { host: this.host, capabilities: capabilitiesFor(this.host), reviewer: this.backend, storage: resolveStorageLayout(this.root).kind,
            evidence: await this.events.status(), engine: await this.engine.status(),
            contextGuarantee: this.host === "generic" ? "tools-only" : capabilitiesFor(this.host).promptContextInjection ? "task-hook" : "after-tool-or-model-selected",
            adapterVerification: "capabilities-declared; consult doctor and the tested version matrix" };
    }
    async close() { await this.engine.dispose(); await this.events.close(); }
}
export async function readStdinJson(maxBytes = 1_048_576) {
    let text = "";
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes)
            throw new Error("AutoSkill hook input exceeds 1 MiB.");
        text += chunk;
    }
    return JSON.parse(text);
}
function spawnWorker(root, host) {
    const entry = fileURLToPath(new URL("../../bin/autoskill.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry, "worker", "--host", host, "--project", root], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, AUTOSKILL_INTERNAL: "1" } });
    child.on("error", () => { });
    child.unref();
}
async function runHook(runtime, eventName, input) {
    if (process.env.AUTOSKILL_INTERNAL === "1")
        return {};
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Hook input must be an object.");
    const event = normalizeHook(runtime.host, { ...input, ...(eventName ? { hook_event_name: eventName } : {}) });
    const accepted = await runtime.events.accept(event);
    if (event.kind === "session-start" && runtime.host === "cursor")
        return hookResponse(runtime.host, event.eventName, "AutoSkill is available. For each new user task, call autoskill_search with a concrete query. Use its contextToken for autoskill_load and autoskill_feedback. Tools do not run skill commands or establish that a skill was used.");
    if (!accepted.task)
        return {};
    if (event.kind === "task-start" && capabilitiesFor(runtime.host).promptContextInjection && !accepted.task.sensitive) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
            return hookResponse(runtime.host, event.eventName, await runtime.context(accepted.task, controller.signal));
        }
        catch {
            process.stderr.write("[AutoSkill] Reuse unavailable for this task; continuing.\n");
            return {};
        }
        finally {
            clearTimeout(timer);
        }
    }
    if (runtime.host === "cursor" && event.kind === "tool-result" && !accepted.reasonCode && !accepted.task.sensitive) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        try {
            return hookResponse(runtime.host, event.eventName, await runtime.context(accepted.task, controller.signal));
        }
        catch {
            return {};
        }
        finally {
            clearTimeout(timer);
        }
    }
    if (event.kind === "task-end") {
        await runtime.capturePending();
        if (runtime.backend.available)
            spawnWorker(runtime.root, runtime.host);
    }
    return {};
}
async function runWorker(runtime, waitMs = 120_000) {
    if (!runtime.backend.available)
        return { status: "unavailable", reasonCode: runtime.backend.reasonCode };
    const release = await acquireFileLock(path.join(resolveStorageLayout(runtime.root).stateRoot, `worker-${runtime.host}.lock`), () => ensurePrivateDirectory(runtime.root));
    if (!release)
        return { status: "busy" };
    try {
        await runtime.capturePending();
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
            const status = await runtime.engine.status();
            const pending = status.jobs?.filter((job) => ["pending", "retry", "running"].includes(job.status)) ?? [];
            if (!pending.length && !status.activeSession)
                return { status: "idle" };
            if (!status.activeSession && pending.every((job) => job.nextRunAt > Date.now() + 3_000))
                return { status: "queued", nextRunAt: Math.min(...pending.map((job) => job.nextRunAt)) };
            await delay(200);
        }
        return { status: "queued", reasonCode: "worker_time_slice_completed" };
    }
    finally {
        await release();
    }
}
export async function runRuntimeCommand(input) {
    if (input.command === "hook" && process.env.AUTOSKILL_INTERNAL === "1")
        return {};
    const runtime = await PortableRuntime.open(input.root, input.host, { background: input.command === "serve" || input.command === "worker", automaticReuse: input.command === "hook" });
    try {
        if (input.command === "serve") {
            const { serveMcp } = await import("../mcp/server.js");
            await runtime.capturePending();
            await serveMcp(runtime);
            return undefined;
        }
        if (input.command === "hook")
            return await runHook(runtime, input.event, input.input ?? await readStdinJson());
        if (input.command === "worker")
            return await runWorker(runtime);
        if (input.command === "status")
            return await runtime.status();
        throw new Error(`Unsupported runtime command: ${input.command}`);
    }
    finally {
        await runtime.close();
    }
}
//# sourceMappingURL=runtime.js.map