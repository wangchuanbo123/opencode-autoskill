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
import { checkOperation, operationSignal, withOperationDeadline } from "../operation-context.js";
export const HOOK_DEADLINE_MS = 2_000;
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
        const port = { root, hostId: host, workspaceId: this.events.workspaceId, hostCapabilities: config.adapters[host]?.capabilities ?? [],
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
        checkOperation();
        const resolved = await fs.realpath(path.resolve(root));
        const config = await readPortableConfig(resolved);
        checkOperation();
        if (!config.adapters[host]?.enabled)
            throw new Error(`AutoSkill adapter ${host} is not enabled; install it for this project first.`);
        return new PortableRuntime(resolved, host, config, options.background === true, options.automaticReuse === true);
    }
    async prepare(task, signal) {
        if (task.sensitive || task.coverage.some((item) => ["superseded_before_completion", "prompt_truncated"].includes(item)))
            throw new Error("Task reuse is excluded by its privacy, completeness or revision policy.");
        await this.engine.prepareReuse({ sessionId: task.id, messageId: task.messageId, text: task.prompt, signal });
    }
    async activate(task, signal) {
        if (task.sensitive || task.coverage.some((item) => ["superseded_before_completion", "prompt_truncated"].includes(item)))
            throw new Error("Task reuse is excluded by its privacy, completeness or revision policy.");
        const restored = await this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash, task.prompt);
        if (restored)
            return restored;
        await this.prepare(task, signal);
        return this.engine.reuseContext(task.id, signal, task.messageId, task.queryHash, task.prompt);
    }
    async context(task, signal) {
        if (this.config.options.enabled === false)
            return "";
        const context = await this.activate(task, signal);
        return `AutoSkill task contextToken: ${task.contextToken}. Use this token with autoskill_search/load/feedback for this task only.\n${context?.text || "No relevant AutoSkill candidate was found for this task."}`;
    }
    async resolveTask(token) {
        if (this.config.options.enabled === false)
            throw new Error("AutoSkill is disabled for this project.");
        if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token))
            throw new Error("A contextToken returned for this task is required.");
        const task = await this.events.token(token, this.host);
        if (!task || task.sensitive || task.coverage.some((item) => ["superseded_before_completion", "prompt_truncated"].includes(item)))
            throw new Error("Task context is missing, superseded or excluded.");
        return task;
    }
    async search(query, token, signal) {
        if (this.config.options.enabled === false)
            return { status: "disabled", reasonCode: "disabled" };
        if (!query.trim() || query.length > 1_500)
            throw new Error("query must contain 1–1500 characters.");
        const task = token ? await this.resolveTask(token) : await this.events.explicit(this.host, query);
        // Activate this exact task without attributing native task outcome to an explicit MCP query.
        await this.activate(task, signal);
        const result = await this.engine.searchReuse({ sessionId: task.id, query, signal });
        return { ...result, contextToken: task.contextToken, association: task.trusted ? "host-task" : "explicit-mcp-query" };
    }
    async load(skillId, token, signal) {
        if (this.config.options.enabled === false)
            return { status: "disabled", reasonCode: "disabled" };
        const task = await this.resolveTask(token);
        await this.activate(task, signal);
        return this.engine.loadReuse({ sessionId: task.id, skillId, signal });
    }
    async feedback(input, signal) {
        if (this.config.options.enabled === false)
            return { status: "disabled", reasonCode: "disabled" };
        const task = await this.resolveTask(input.contextToken);
        await this.activate(task, signal);
        return this.engine.reuseFeedback({ sessionId: task.id, skillId: input.skillId, used: input.used, outcome: input.outcome, signal });
    }
    async capturePending() {
        if (this.config.options.enabled === false)
            return 0;
        let captured = 0;
        for (const task of await this.events.pending(this.host)) {
            if (task.coverage.includes("superseded_before_completion")) {
                await this.engine.invalidate(task.id);
                await this.events.captured(task.id);
                continue;
            }
            if (!task.trusted || task.coverage.some((item) => ["tool_count_budget", "prompt_truncated"].includes(item)) || task.sensitive) {
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
        if (this.config.options.enabled === false)
            return { status: "disabled", reasonCode: "disabled" };
        const task = await this.resolveTask(token);
        if (!task.trusted || !task.ended)
            return { status: "unavailable", reasonCode: "trusted_completed_evidence_required" };
        if (!this.backend.available)
            return { status: "unavailable", reasonCode: this.backend.reasonCode };
        return this.engine.review(task.id, false, signal, dryRun);
    }
    async status() {
        const evidence = await this.events.status();
        const engine = await this.engine.status();
        const queued = engine.jobs?.filter(job => (!job.hostId || job.hostId === this.host) && ["pending", "retry", "running"].includes(job.status)) ?? [];
        const observed = evidence.observations.some(item => item.host === this.host);
        const phase = !engine.enabled ? "disabled" : engine.lastFailure?.reasonCode === "initialization_failed" ? "unavailable" : this.host === "generic" ? "tools-only" : !this.backend.available ? "reuse-only" : engine.activeSession ? "reviewing" : queued.length ? "queued" : !observed ? "awaiting-host" : "ready";
        const summaries = {
            disabled: "AutoSkill is disabled. New task hooks and MCP reuse do not collect or process task evidence.",
            unavailable: "Runtime initialization failed. Run doctor and inspect storage access before retrying.",
            "tools-only": "MCP search and load are available. Generic MCP does not observe other tools or automatically distill tasks.",
            "reuse-only": "Skill reuse and task capture are available. Automatic review is waiting for the configured reviewer.",
            reviewing: "A captured task is being reviewed.", queued: "Captured tasks are waiting for processing or their retry window.",
            "awaiting-host": "The adapter is enabled. No host hook has been observed yet; run a task after the host trusts its configuration.",
            ready: "Host hooks have been observed. No review is currently queued.",
        };
        return { host: this.host, capabilities: capabilitiesFor(this.host), reviewer: this.backend, storage: resolveStorageLayout(this.root).kind,
            summary: { phase, message: summaries[phase], skillCount: engine.skills?.length ?? 0, queuedReviews: queued.length,
                pendingEvidence: evidence.pendingEvidence, nextRunAt: queued.length ? Math.min(...queued.map(job => job.nextRunAt)) : undefined,
                lastReasonCode: engine.lastDecision?.reasonCode, ...(phase === "reuse-only" ? { nextAction: "Configure reviewer in .autoskill/config.json and provide its apiKeyEnv in the environment that launches the host." } : {}) },
            evidence, engine,
            contextGuarantee: this.host === "generic" ? "tools-only" : capabilitiesFor(this.host).promptContextInjection ? "task-hook" : "after-tool-or-model-selected",
            adapterVerification: "capabilities-declared; consult doctor and the tested version matrix" };
    }
    async close() { await this.engine.dispose(); await this.events.close(); }
}
export async function readStdinJson(maxBytes = 1_048_576) {
    const signal = operationSignal();
    signal?.throwIfAborted();
    const abort = () => { process.stdin.destroy(new Error("AutoSkill hook input timed out.")); };
    signal?.addEventListener("abort", abort, { once: true });
    const chunks = [];
    let bytes = 0;
    try {
        for await (const chunk of process.stdin) {
            checkOperation();
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += part.byteLength;
            if (bytes > maxBytes)
                throw new Error("AutoSkill hook input exceeds 1 MiB.");
            chunks.push(part);
        }
        checkOperation();
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    finally {
        signal?.removeEventListener("abort", abort);
    }
}
function spawnWorker(root, host) {
    const entry = fileURLToPath(new URL("../../bin/autoskill.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry, "worker", "--host", host, "--project", root], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, AUTOSKILL_INTERNAL: "1" } });
    child.on("error", () => { });
    child.unref();
}
async function runHook(runtime, eventName, input) {
    if (process.env.AUTOSKILL_INTERNAL === "1" || runtime.config.options.enabled === false)
        return {};
    checkOperation();
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Hook input must be an object.");
    const event = normalizeHook(runtime.host, { ...input, ...(eventName ? { hook_event_name: eventName } : {}) });
    if (event.kind === "subagent-start" && runtime.config.agentPolicy === "inherit" && ["claude-code", "codex"].includes(runtime.host)) {
        const parent = await runtime.events.current(runtime.host, event.parentId ?? event.sessionId);
        if (!parent || parent.sensitive || parent.ended)
            return {};
        try {
            return hookResponse(runtime.host, event.eventName, "Inherited AutoSkill references from the parent task. Check applicability to this subtask; model reports remain associated with the parent task.\n" + await runtime.context(parent, operationSignal()));
        }
        catch {
            return {};
        }
    }
    const accepted = await runtime.events.accept(event);
    for (const id of accepted.invalidatedTaskIds ?? [])
        await runtime.engine.invalidate(id);
    if (event.kind === "session-start" && runtime.host === "cursor")
        return hookResponse(runtime.host, event.eventName, "AutoSkill is available. For each new user task, call autoskill_search with a concrete query. Use its contextToken for autoskill_load and autoskill_feedback. Tools do not run skill commands or establish that a skill was used.");
    if (!accepted.task)
        return {};
    if (event.kind === "task-start" && capabilitiesFor(runtime.host).promptContextInjection && !accepted.task.sensitive) {
        try {
            const response = hookResponse(runtime.host, event.eventName, await runtime.context(accepted.task, operationSignal()));
            await runtime.events.delivered(accepted.task.id);
            return response;
        }
        catch {
            process.stderr.write("[AutoSkill] Reuse unavailable for this task; continuing.\n");
            return {};
        }
    }
    if (runtime.host === "cursor" && event.kind === "tool-result" && !accepted.reasonCode && !accepted.task.sensitive && !accepted.task.contextDelivered) {
        try {
            const response = hookResponse(runtime.host, event.eventName, await runtime.context(accepted.task, operationSignal()));
            await runtime.events.delivered(accepted.task.id);
            return response;
        }
        catch {
            return {};
        }
    }
    if (event.kind === "task-end") {
        // The boundary is already durable. A lock timeout in this short process
        // must not prevent an independent worker from recovering that boundary.
        try {
            await runtime.capturePending();
        }
        finally {
            if (runtime.backend.available)
                spawnWorker(runtime.root, runtime.host);
        }
    }
    return {};
}
async function runWorker(runtime, waitMs = 120_000) {
    if (runtime.config.options.enabled === false)
        return { status: "disabled", reasonCode: "disabled" };
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
            const pending = status.jobs?.filter((job) => (!job.hostId || job.hostId === runtime.host) && ["pending", "retry", "running"].includes(job.status)) ?? [];
            if (!pending.length && !status.activeSession)
                return { status: "idle" };
            const nextRunAt = Math.min(...pending.map(job => job.nextRunAt));
            if (!status.activeSession && nextRunAt >= until)
                return { status: "queued", nextRunAt };
            await delay(!status.activeSession && nextRunAt > Date.now() ? Math.min(1_000, Math.max(25, nextRunAt - Date.now())) : 200);
        }
        return { status: "queued", reasonCode: "worker_time_slice_completed" };
    }
    finally {
        await release();
    }
}
async function executeRuntimeCommand(input) {
    if (input.command === "hook" && process.env.AUTOSKILL_INTERNAL === "1")
        return {};
    if (input.command === "hook" && (await readPortableConfig(input.root)).options.enabled === false)
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
        if (input.command === "review") {
            const args = input.input;
            return await runtime.review(args?.contextToken, input.dryRun);
        }
        throw new Error(`Unsupported runtime command: ${input.command}`);
    }
    finally {
        await runtime.close();
    }
}
export async function runRuntimeCommand(input) {
    if (input.command !== "hook")
        return executeRuntimeCommand(input);
    return withOperationDeadline(HOOK_DEADLINE_MS, () => executeRuntimeCommand(input));
}
//# sourceMappingURL=runtime.js.map