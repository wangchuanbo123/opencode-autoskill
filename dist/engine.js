import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readOptions } from "./config.js";
import { SkillStore, SkillConflictError } from "./skills.js";
import { QueueStore, GlobalBudgetStore } from "./jobs.js";
import { DraftStore } from "./drafts.js";
import { buildReviewInput, parseDecision } from "./review.js";
import { collectTasks, assessComplexity, COMPLEXITY_POLICY_VERSION, digest, matchesSession, scopedSessionId } from "./tasks.js";
import { PLUGIN_VERSION } from "./version.js";
import { ReuseEngine } from "./reuse.js";
import { truncate } from "./safety.js";
class Stop extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function stopCode(signal) { return signal.reason instanceof Stop ? signal.reason.code : "user_cancelled"; }
async function bounded(work, signal) {
    signal.throwIfAborted();
    let listener;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
                listener = () => reject(signal.reason ?? new Stop("user_cancelled"));
                signal.addEventListener("abort", listener, { once: true });
            })]);
    }
    finally {
        if (listener)
            signal.removeEventListener("abort", listener);
    }
}
const result = (status, reasonCode, reason, extra = {}) => ({ status, reasonCode, reason, ...extra });
const nextDay = () => Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z") + 86_400_000;
export class AutoSkillEngine {
    port;
    options;
    ready;
    root;
    store;
    queue;
    global;
    drafts;
    reuse;
    active;
    timer;
    collections = new Set();
    controllers = new Set();
    disposed = false;
    manual = 0;
    lastFailure;
    constructor(port) {
        this.port = port;
        this.options = readOptions(port.options);
        const initial = path.resolve(port.root);
        this.root = initial;
        this.ready = (async () => {
            const stat = await fs.lstat(initial);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error("Project root must be a real directory.");
            this.root = await fs.realpath(initial);
            this.store = new SkillStore(this.root);
            this.queue = new QueueStore(this.root);
            this.global = new GlobalBudgetStore(this.options.globalStateDirectory);
            this.drafts = new DraftStore(this.root);
            this.reuse = new ReuseEngine(this.root, this.options, this.port);
            const recovery = await this.queue.recover();
            await this.store.list();
            await this.reconcile(recovery.publications);
            await this.queue.transaction((state) => {
                state.capabilities = this.port.capabilities ?? { supported: true, missing: [], hostVersion: "not-reported" };
                state.reuseCapabilities = this.port.reuseCapabilities ?? { supported: true, missing: [], hostVersion: "not-reported" };
                state.lastRecoveryAt = Date.now();
            });
            this.wake(250);
        })();
        void this.ready.catch(() => { this.lastFailure = result("failed", "initialization_failed", "AutoSkill initialization failed; run doctor for runtime and path diagnostics."); this.port.log("error", this.lastFailure.reason); });
    }
    schedule(sessionId, terminal) {
        if (this.disposed || !this.options.enabled)
            return;
        if ((terminal === "failure" || terminal === "interrupted") && this.active?.sessionId === sessionId)
            this.active.controller.abort(new Stop("execution_interrupted"));
        const operation = this.capture(sessionId, terminal, false).catch(() => this.note(sessionId, result("failed", "capture_failed", "Could not capture evidence; its durable request can be retried.")))
            .finally(() => { this.collections.delete(operation); this.wake(this.options.debounceMs); });
        this.collections.add(operation);
    }
    /** Persist completed evidence before a short-lived host hook exits. */
    async enqueue(sessionId, terminal = "unknown", signal) {
        return (await this.capture(sessionId, terminal, false, signal)).last;
    }
    sessionKey(sessionId) { return scopedSessionId(sessionId, this.port.hostId, this.port.workspaceId ?? this.root); }
    ownsJob(job) { return job.hostId === this.port.hostId && job.workspaceId === this.port.workspaceId; }
    async note(sessionId, value, jobId) {
        try {
            await this.queue.record(this.sessionKey(sessionId), value, value.reasonCode ?? "unknown", jobId);
        }
        catch {
            this.port.log("warn", "AutoSkill diagnostic export failed; inspect runtime SQLite state.");
        }
        if (value.status === "failed")
            this.lastFailure = value;
        return value;
    }
    async reconcile(publications) {
        for (const job of publications) {
            if (!job.publication?.skillId)
                continue;
            const info = await this.store.inspect(job.publication.skillId).catch(() => undefined);
            const source = info?.provenance;
            if (source?.fingerprint !== job.fingerprint || source.taskId !== job.id || info?.skill.ownership !== "managed")
                continue;
            const changed = await this.queue.transaction((state) => {
                const current = state.jobs[job.id];
                if (!current || current.status === "running")
                    return false;
                current.status = "saved";
                current.result = result("saved", "publication_recovered", "Recovered an already published skill.", { skillId: info.skill.id, path: info.skill.path, taskId: job.id });
                current.reasonCode = "publication_recovered";
                current.updatedAt = Date.now();
                current.publication = { stage: "committed", skillId: info.skill.id, path: info.skill.path, sha256: info.skill.sha256, updatedAt: Date.now() };
                return true;
            });
            if (changed)
                await this.note(job.sessionId, result("saved", "publication_recovered", "Recovered an already published skill.", { skillId: info.skill.id, taskId: job.id }), job.id);
        }
    }
    allowed(snapshot) {
        const internal = snapshot.origin ? ["reviewer", "maintenance"].includes(snapshot.origin.kind) : snapshot.agent?.startsWith("autoskill");
        const child = !!snapshot.parentId || snapshot.origin?.kind === "subagent";
        return !internal && (!child || this.options.agentPolicy === "independent") && !matchesSession(snapshot.sessionId, this.options.excludeSessions);
    }
    async inProject(snapshot) { try {
        return await fs.realpath(snapshot.directory) === this.root;
    }
    catch {
        return false;
    } }
    screeningKey() { return digest([COMPLEXITY_POLICY_VERSION, this.options.minComplexityScore]); }
    taskAssessments(snapshot, packets) {
        const assessments = new Map();
        for (const taskId of new Set(packets.map((packet) => packet.taskId))) {
            const parts = packets.filter((packet) => packet.taskId === taskId);
            const tools = new Map(parts.flatMap((packet) => packet.snapshot.messages.flatMap((message) => message.tools)).map((tool) => [tool.id, tool]));
            const ordered = snapshot.messages.flatMap((message) => message.tools).flatMap((tool) => {
                const value = tools.get(tool.id);
                if (!value)
                    return [];
                tools.delete(tool.id);
                return [value];
            });
            const combined = { ...parts[0].snapshot, messages: parts[0].snapshot.messages.map((message) => ({ ...message, tools: [] })) };
            const assistant = combined.messages.find((message) => message.role === "assistant");
            if (assistant)
                assistant.tools = ordered;
            assessments.set(taskId, assessComplexity(combined, this.options));
        }
        return assessments;
    }
    async capture(sessionId, terminal, force, signal, manual = false) {
        await this.ready;
        if (this.port.capabilities?.supported === false)
            return { packets: [], last: await this.note(sessionId, result("skipped", "unsupported_host", "Required OpenCode plugin capabilities are unavailable.")) };
        if (matchesSession(sessionId, this.options.excludeSessions))
            return { packets: [], last: await this.note(sessionId, result("skipped", "session_excluded", "Session excluded by privacy policy.")) };
        const requestId = digest(["capture", this.sessionKey(sessionId)]);
        await this.queue.transaction((state) => {
            const previous = state.jobs[requestId];
            if (!previous || previous.status !== "running")
                state.jobs[requestId] = { id: requestId, sessionId, hostId: this.port.hostId, workspaceId: this.port.workspaceId, fingerprint: "capture", status: "pending", attempts: 0,
                    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(), nextRunAt: Date.now() + this.options.debounceMs, sourceTerminal: terminal };
            state.lastEventAt = Date.now();
        });
        const controller = signal ? undefined : new AbortController();
        const usedSignal = signal ?? controller.signal;
        const timer = controller ? setTimeout(() => controller.abort(new Stop("capture_timeout")), Math.min(10_000, this.options.reviewTimeoutMs)) : undefined;
        let snapshot;
        try {
            snapshot = await bounded(this.port.snapshot(sessionId, terminal, usedSignal), usedSignal);
        }
        catch {
            if (signal?.aborted)
                throw signal.reason;
            await this.queue.transaction((state) => { const job = state.jobs[requestId]; if (job) {
                job.status = "retry";
                job.nextRunAt = Date.now() + this.options.retryBaseMs;
            } });
            return { packets: [], last: await this.note(sessionId, result("queued", "capture_unavailable", "Waiting for a readable completed task boundary."), requestId) };
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        if (snapshot.sessionId !== sessionId || !this.allowed(snapshot) || !await this.inProject(snapshot)) {
            await this.queue.transaction((state) => { state.jobs[requestId].status = "skipped"; });
            return { packets: [], last: await this.note(sessionId, result("skipped", "outside_scope", "Only top-level tasks in this project are eligible."), requestId) };
        }
        const bookkeeping = new AbortController();
        const bookkeepingTimer = setTimeout(() => bookkeeping.abort(new Stop("reuse_bookkeeping_timeout")), this.options.reuseTimeoutMs);
        const bookkeepingSignal = signal ? AbortSignal.any([signal, bookkeeping.signal]) : bookkeeping.signal;
        try {
            await bounded(this.reuse.finish(snapshot, bookkeepingSignal), bookkeepingSignal);
        }
        catch {
            this.port.log("warn", "Reuse outcome bookkeeping is unavailable; task review continues.");
        }
        finally {
            clearTimeout(bookkeepingTimer);
        }
        signal?.throwIfAborted();
        const packets = collectTasks(snapshot, this.options, this.root);
        const legacy = (await this.queue.read()).sessions[this.sessionKey(sessionId)]?.cursor;
        const oldIndex = legacy ? snapshot.messages.findIndex((message) => message.id === legacy) : -1;
        let last = result("skipped", "no_task_evidence", "No complete user task evidence was found.");
        const currentPacketIds = new Set(packets.map((packet) => packet.id));
        const taskScores = this.taskAssessments(snapshot, packets);
        for (const packet of packets) {
            if (oldIndex >= 0 && packet.snapshot.messages.every((message) => snapshot.messages.findIndex((item) => item.id === message.id) <= oldIndex))
                continue;
            const score = taskScores.get(packet.taskId);
            let code = !packet.eligible ? packet.reasonCode : !force && !score.eligible ? "below_complexity_threshold" : undefined;
            const reasons = { unfinished_tools: "This task still has unfinished tools.", below_complexity_threshold: "Observed evidence does not establish a non-routine method with independent verification.",
                sensitive_content: "Task excluded by custom sensitive-content policy.", execution_not_successful: "Task has no successful completed execution.", no_assistant_evidence: "Task has no completed assistant execution evidence." };
            let value = code ? result("skipped", code, reasons[code] ?? "Task did not meet review eligibility requirements.", { taskId: packet.id })
                : result("queued", "task_queued", "Task evidence is durably queued.", { taskId: packet.id });
            const inserted = await this.queue.transaction((state) => {
                const prior = state.jobs[packet.id];
                const policyChanged = prior?.screeningKey !== this.screeningKey();
                const canRescreen = prior && prior.status === "skipped" && prior.reasonCode === "below_complexity_threshold" && (policyChanged || manual && force);
                if (prior && ["pending", "retry"].includes(prior.status)) {
                    prior.force ||= manual && force;
                    if (code === "below_complexity_threshold" && prior.force) {
                        code = undefined;
                        value = result("queued", "task_queued", "Task evidence is durably queued for explicit review.", { taskId: packet.id });
                    }
                    prior.preScreen = score;
                    prior.screeningKey = this.screeningKey();
                    prior.complexityScore = score.score;
                    prior.logicalSteps = score.logicalSteps;
                    if (code) {
                        prior.status = "skipped";
                        prior.reasonCode = code;
                        prior.result = value;
                        prior.updatedAt = Date.now();
                        return true;
                    }
                    return false;
                }
                if (prior && !canRescreen)
                    return false;
                for (const previous of Object.values(state.jobs))
                    if (previous.taskId === packet.taskId && !currentPacketIds.has(previous.id) && ["pending", "retry"].includes(previous.status)) {
                        previous.status = "cancelled";
                        previous.reasonCode = "evidence_revised";
                    }
                state.jobs[packet.id] = { id: packet.id, sessionId, hostId: this.port.hostId, workspaceId: this.port.workspaceId, fingerprint: packet.fingerprint, taskId: packet.taskId, anchorId: packet.anchorId,
                    status: code ? "skipped" : "pending", snapshot: packet.snapshot, coverage: packet.coverage, attempts: prior?.attempts ?? 0,
                    createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now(), nextRunAt: manual ? Date.now() : Date.now() + this.options.debounceMs,
                    force, reasonCode: code, result: value, complexityScore: score.score, logicalSteps: score.logicalSteps,
                    preScreen: score, screeningKey: this.screeningKey() };
                return true;
            });
            if (inserted) {
                await this.note(sessionId, value, packet.id);
                for (const tool of packet.snapshot.messages.flatMap((message) => message.tools).filter((tool) => tool.name === "skill" && tool.status === "completed")) {
                    const id = tool.input && typeof tool.input === "object" && "id" in tool.input ? String(tool.input.id) : undefined;
                    if (!id)
                        continue;
                    const first = await this.queue.transaction((state) => { state.observedSkillTools ??= {}; if (state.observedSkillTools[tool.id])
                        return false; state.observedSkillTools[tool.id] = true; return true; });
                    if (first)
                        await this.store.recordUsage(id).catch(() => undefined);
                }
            }
            last = inserted ? value : result("skipped", "already_reviewed", "Task evidence is already queued or reviewed.", { taskId: packet.id });
        }
        await this.queue.transaction((state) => { const request = state.jobs[requestId]; if (request) {
            request.status = "skipped";
            request.reasonCode = "capture_complete";
        } });
        return { packets, last };
    }
    review(sessionId, force = false, signal, dryRun = false) {
        const operation = this.runReview(sessionId, force, signal, dryRun).finally(() => { this.collections.delete(operation); });
        this.collections.add(operation);
        return operation;
    }
    async runReview(sessionId, force, signal, dryRun) {
        if (this.disposed || !this.options.enabled)
            return result("skipped", "disabled", "AutoSkill is disabled.");
        if (this.active || this.manual)
            return result("busy", "review_busy", "A review is already running.");
        this.manual++;
        const controller = new AbortController();
        this.controllers.add(controller);
        const cancel = () => controller.abort(signal?.reason ?? new Stop("user_cancelled"));
        if (signal?.aborted)
            cancel();
        else
            signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => controller.abort(new Stop("review_timeout")), this.options.reviewTimeoutMs);
        try {
            await bounded(this.ready, controller.signal);
            controller.signal.throwIfAborted();
            const captured = await this.capture(sessionId, "idle", force, controller.signal, true);
            controller.signal.throwIfAborted();
            const state = await this.queue.read();
            const jobs = Object.values(state.jobs).filter((job) => this.ownsJob(job) && job.sessionId === sessionId && job.snapshot && ["pending", "retry"].includes(job.status)).sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt);
            const job = jobs[0];
            if (!job)
                return Object.values(state.jobs).some((item) => this.ownsJob(item) && item.sessionId === sessionId && item.status === "running")
                    ? result("busy", "review_busy", "Another worker is reviewing this task.") : captured.last;
            if (job.nextRunAt > Date.now())
                return result("queued", job.reasonCode ?? "retry_scheduled", "Task is queued until its budget, cooldown or retry deadline permits review.", { taskId: job.id, nextRunAt: job.nextRunAt });
            return await this.start(job.id, controller, dryRun);
        }
        catch (error) {
            const code = controller.signal.aborted ? stopCode(controller.signal) : "review_failed";
            return this.note(sessionId, result(code === "user_cancelled" ? "cancelled" : "failed", code, code === "review_timeout" ? "Review timed out before completion." : "Review could not complete; inspect status and doctor diagnostics."));
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            this.controllers.delete(controller);
            this.manual--;
            this.wake(25);
        }
    }
    wake(delay) {
        if (this.disposed || this.port.backgroundWorker === false || !this.options.enabled || this.port.capabilities?.supported === false)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = undefined; void this.drain().catch(() => { this.port.log("warn", "AutoSkill queue is temporarily unavailable; retrying."); this.wake(this.options.retryBaseMs); }); }, Math.min(2_147_000_000, Math.max(5, delay)));
        this.timer.unref();
    }
    async drain() {
        await this.ready;
        if (this.disposed)
            return;
        if (this.active || this.manual || this.collections.size) {
            this.wake(100);
            return;
        }
        await this.reconcile((await this.queue.recover()).publications);
        const waiting = Object.values((await this.queue.read()).jobs).filter((job) => this.ownsJob(job) && ["pending", "retry"].includes(job.status)).sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt);
        const job = waiting[0];
        if (!job)
            return;
        if (job.nextRunAt > Date.now()) {
            this.wake(job.nextRunAt - Date.now());
            return;
        }
        if (!job.snapshot) {
            const operation = this.capture(job.sessionId, job.sourceTerminal ?? "idle", false);
            this.collections.add(operation);
            try {
                await operation;
            }
            finally {
                this.collections.delete(operation);
                this.wake(25);
            }
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Stop("review_timeout")), this.options.reviewTimeoutMs);
        try {
            await this.start(job.id, controller, false);
        }
        finally {
            clearTimeout(timer);
            this.wake(25);
        }
    }
    start(id, controller, dryRun) {
        const promise = this.execute(id, controller.signal, dryRun).finally(() => { if (this.active?.promise === promise)
            this.active = undefined; });
        this.active = { sessionId: "", controller, promise };
        return promise;
    }
    async skills(signal) {
        const local = await bounded(this.store.list(), signal);
        const remote = await bounded(this.port.listSkills(signal), signal);
        const reuseStats = await bounded(this.reuse.ledger.history(), signal);
        const merged = new Map(remote.map((skill) => [skill.id, { ...skill, managed: false }]));
        for (const skill of local) {
            const stats = reuseStats.find((item) => item.skillId === skill.id && item.sha256 === skill.sha256);
            merged.set(skill.id, { ...skill, feedback: { success: (skill.versionFeedback?.success ?? 0) + (stats?.userFeedback.success ?? 0), failure: (skill.versionFeedback?.failure ?? 0) + (stats?.userFeedback.failure ?? 0) },
                reuseFeedback: stats ? { loaded: stats.loaded, reportedUsed: stats.reportedUsed, user: stats.userFeedback, model: stats.modelFeedback } : undefined });
        }
        return [...merged.values()];
    }
    async complete(job, token, value, status, nextRunAt) {
        const accepted = await this.queue.transaction((state) => {
            const current = state.jobs[job.id];
            if (!current || current.status !== "running" || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                return false;
            current.status = status;
            current.result = value;
            current.reasonCode = value.reasonCode;
            current.updatedAt = Date.now();
            if (nextRunAt !== undefined)
                current.nextRunAt = nextRunAt;
            delete current.lease;
            return true;
        });
        return accepted ? this.note(job.sessionId, value, job.id) : result("cancelled", "lease_lost", "Review ownership expired; no further publication is permitted.", { taskId: job.id });
    }
    async execute(id, signal, dryRun) {
        const job = await this.queue.claim(id, this.options.reviewTimeoutMs + 30_000);
        if (!job?.snapshot || !job.lease)
            return result("busy", "review_busy", "Task is owned by another worker or is not due.");
        if (this.active)
            this.active.sessionId = job.sessionId;
        const token = job.lease.token;
        let committed;
        let plannedSkillId;
        let phase = "preparation";
        try {
            signal.throwIfAborted();
            const snapshot = job.snapshot;
            if (!this.allowed(snapshot) || !await this.inProject(snapshot))
                return this.complete(job, token, result("skipped", "outside_scope", "Task is outside this project's scope."), "skipped");
            const draft = await bounded(this.drafts.inspect(id).catch(() => undefined), signal);
            if (draft?.provenance.fingerprint === job.fingerprint && draft.provenance.taskId === id) {
                const status = draft.status ?? "draft";
                if (status === "draft")
                    return this.complete(job, token, result("draft", draft.decision.assessment ? "draft_recovered" : "legacy_draft_requires_review", draft.decision.assessment ? "Recovered a candidate; publication revalidates it under the current rules." : "Recovered a legacy candidate without the required assessment. Inspect or discard it; a newly completed task must pass the current review before publication.", { taskId: id, skillId: draft.decision.skill?.id }), "draft");
                if (status === "discarded")
                    return this.complete(job, token, result("skipped", "draft_discarded", "This candidate was already discarded.", { taskId: id }), "skipped");
            }
            let preScreen = job.preScreen;
            if (job.screeningKey !== this.screeningKey() || !preScreen) {
                const latest = await bounded(this.port.snapshot(job.sessionId, "idle", signal), signal);
                signal.throwIfAborted();
                if (latest.sessionId !== job.sessionId || !this.allowed(latest) || !await this.inProject(latest))
                    return this.complete(job, token, result("skipped", "outside_scope", "Task is outside this project's scope."), "skipped");
                const packets = collectTasks(latest, this.options, this.root);
                const packet = packets.find((item) => item.id === id);
                if (!packet?.eligible)
                    return this.complete(job, token, result("cancelled", "evidence_changed", "Queued evidence no longer matches a completed eligible task.", { taskId: id }), "cancelled");
                preScreen = this.taskAssessments(latest, packets).get(packet.taskId);
                await this.queue.transaction((state) => {
                    signal.throwIfAborted();
                    const current = state.jobs[id];
                    if (!current || current.status !== "running" || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                        throw new Stop("lease_lost");
                    current.preScreen = preScreen;
                    current.screeningKey = this.screeningKey();
                    current.complexityScore = preScreen.score;
                    current.logicalSteps = preScreen.logicalSteps;
                });
            }
            if (!job.force && !preScreen.eligible)
                return this.complete(job, token, result("skipped", "below_complexity_threshold", "Observed evidence does not establish a non-routine method with independent verification.", { taskId: id }), "skipped");
            const model = this.options.model ?? snapshot.model;
            if (this.options.providerAllowlist.length && (!model || !this.options.providerAllowlist.includes(model.providerID)))
                return this.complete(job, token, result("skipped", "provider_excluded", "Review provider is excluded by privacy policy."), "skipped");
            const existing = await this.skills(signal);
            const input = await bounded(buildReviewInput(snapshot, existing, this.options, this.root, { preScreen }), signal);
            if (!input.hasUserTask || [...input.evidence.values()].filter((tool) => tool.status === "completed" && tool.output.trim()).length < 2)
                return this.complete(job, token, result("skipped", "insufficient_evidence", "Insufficient independent successful tool evidence."), "skipped");
            const budget = await this.queue.transaction((state) => {
                signal.throwIfAborted();
                const current = state.jobs[id];
                if (!current || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                    throw new Stop("lease_lost");
                const day = new Date().toISOString().slice(0, 10);
                if (state.day !== day) {
                    state.day = day;
                    state.reviews = 0;
                }
                if (state.inputTokensDay !== day) {
                    state.inputTokensDay = day;
                    state.inputTokens = 0;
                }
                if (current.attempts >= this.options.maxAttempts)
                    return { code: "attempt_limit", at: 0 };
                if (state.reviews >= this.options.maxReviewsPerDay || (state.inputTokens ?? 0) + input.estimatedInputTokens > this.options.maxEstimatedTokensPerDay)
                    return { code: "project_daily_budget", at: nextDay() };
                const at = (state.sessions[this.sessionKey(job.sessionId)]?.lastReview ?? 0) + this.options.cooldownMs;
                if (at > Date.now())
                    return { code: "session_cooldown", at };
                return undefined;
            });
            if (budget)
                return this.complete(job, token, result(budget.at ? "queued" : "skipped", budget.code, budget.at ? "Review is queued for the next budget or cooldown window." : "Review attempt limit reached.", { taskId: id, nextRunAt: budget.at || undefined }), budget.at ? "retry" : "skipped", budget.at || undefined);
            const reservation = await bounded(this.global.reserve(digest([this.root, job.id, job.attempts + 1]), { maxReviewsPerDay: this.options.maxGlobalReviewsPerDay,
                estimatedInputTokens: input.estimatedInputTokens, maxInputTokensPerDay: this.options.maxGlobalEstimatedTokensPerDay }), signal);
            if (!reservation.allowed)
                return this.complete(job, token, result("queued", reservation.reasonCode, "Review is queued until the shared daily budget resets.", { taskId: id, nextRunAt: reservation.nextRunAt }), "retry", reservation.nextRunAt);
            const recheck = await this.queue.transaction((state) => {
                signal.throwIfAborted();
                const current = state.jobs[id];
                if (!current || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                    throw new Stop("lease_lost");
                if (state.reviews >= this.options.maxReviewsPerDay || (state.inputTokens ?? 0) + input.estimatedInputTokens > this.options.maxEstimatedTokensPerDay)
                    return { code: "project_daily_budget", at: nextDay() };
                const at = (state.sessions[this.sessionKey(job.sessionId)]?.lastReview ?? 0) + this.options.cooldownMs;
                if (at > Date.now())
                    return { code: "session_cooldown", at };
                current.attempts++;
                job.attempts = current.attempts;
                current.estimatedInputTokens = input.estimatedInputTokens;
                state.reviews++;
                state.inputTokens = (state.inputTokens ?? 0) + input.estimatedInputTokens;
                state.sessions[this.sessionKey(job.sessionId)] = { ...state.sessions[this.sessionKey(job.sessionId)], lastReview: Date.now() };
                return undefined;
            });
            if (recheck)
                return this.complete(job, token, result("queued", recheck.code, "Review is queued for the next budget or cooldown window.", { taskId: id, nextRunAt: recheck.at }), "retry", recheck.at);
            phase = "provider";
            const output = await bounded(this.port.generate({ sessionId: job.sessionId, prompt: input.prompt, model, signal }), signal);
            signal.throwIfAborted();
            phase = "validation";
            const decision = parseDecision(output, input.evidence, existing.map((skill) => ({ ...skill, managed: skill.managed && input.updateableIds.has(skill.id) })), this.options, this.root);
            const current = await bounded(this.port.snapshot(job.sessionId, "idle", signal), signal);
            signal.throwIfAborted();
            if (current.sessionId !== job.sessionId || !this.allowed(current) || !await this.inProject(current) || !collectTasks(current, this.options, this.root).some((packet) => packet.id === id && packet.eligible)) {
                return this.complete(job, token, result("cancelled", "evidence_changed", "Task evidence changed while the review was running; this candidate was discarded.", { taskId: id }), "cancelled");
            }
            if (decision.action === "skip")
                return this.complete(job, token, result("skipped", "model_skipped", decision.reason, { taskId: id }), "skipped");
            const assessment = decision.assessment ? structuredClone(decision.assessment) : undefined;
            if (assessment && this.options.storeEvidence === "none") {
                for (const dimension of assessment.complexity.dimensions)
                    dimension.evidence = [];
                assessment.value.evidence = [];
            }
            const provenance = { schemaVersion: 2, pluginVersion: PLUGIN_VERSION, sessionId: job.sessionId, hostId: snapshot.hostId, workspaceId: snapshot.workspaceId,
                turnId: snapshot.turnId, revision: snapshot.revision, taskId: id, fingerprint: job.fingerprint,
                messageIds: snapshot.messages.map((message) => message.id), evidence: this.options.storeEvidence === "none" ? [] : decision.evidence ?? [],
                createdAt: new Date().toISOString(), model, templateHash: input.templateHash, decisionReason: decision.reason, assessment };
            const expectedPreviousHash = decision.action === "update" ? existing.find((skill) => skill.id === decision.skill?.id)?.sha256 : undefined;
            plannedSkillId = decision.skill.id;
            signal.throwIfAborted();
            phase = "publication";
            if (dryRun || this.options.mode === "draft") {
                await bounded(this.drafts.create({ id, decision, provenance, evidence: [...input.evidence.values()], expectedPreviousHash, options: this.options }), signal);
                return this.complete(job, token, result("draft", "draft_created", "A validated candidate is ready for inspection and publication.", { taskId: id, skillId: decision.skill.id }), "draft");
            }
            await this.queue.transaction((state) => {
                signal.throwIfAborted();
                const current = state.jobs[id];
                if (!current || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                    throw new Stop("lease_lost");
                current.publication = { stage: "prepared", skillId: decision.skill.id, updatedAt: Date.now() };
            });
            const saved = await this.store.save(decision, provenance, { expectedPreviousHash, signal, maxManagedSkills: this.options.maxManagedSkills,
                beforeCommit: async () => {
                    await this.queue.transaction((state) => {
                        signal.throwIfAborted();
                        const current = state.jobs[id];
                        if (!current || current.status !== "running" || current.lease?.token !== token || current.lease.expiresAt <= Date.now())
                            throw new Stop("lease_lost");
                    });
                } });
            // Installing the Markdown is the commit point. Later cancellation cannot undo it.
            committed = result("saved", "skill_saved", saved.changed ? "Saved a verified reusable skill." : "Skill content is already current.", { skillId: saved.id, path: saved.path, taskId: id });
            await this.queue.transaction((state) => {
                const current = state.jobs[id];
                if (!current || current.lease?.token !== token)
                    return;
                current.publication = { stage: "committed", skillId: saved.id, path: saved.path, sha256: saved.sha256, updatedAt: Date.now() };
            });
            const completed = await this.complete(job, token, committed, "saved");
            try {
                await bounded(this.port.reloadSkills(signal), signal);
            }
            catch {
                this.port.log("warn", "Skill saved; host discovery refresh will retry on its next reload.");
            }
            return completed;
        }
        catch (error) {
            if (committed) {
                this.port.log("warn", "Skill was published; its queue metadata will recover on restart.");
                return committed;
            }
            if (phase === "publication" && plannedSkillId) {
                const published = await this.store.inspect(plannedSkillId).catch(() => undefined);
                const source = published?.provenance;
                if (published?.skill.ownership === "managed" && source?.taskId === id && source.fingerprint === job.fingerprint) {
                    const recovered = result("saved", "publication_recovered", "Skill publication completed and its metadata was recovered.", { taskId: id, skillId: plannedSkillId, path: published.skill.path });
                    await this.queue.transaction((state) => {
                        const current = state.jobs[id];
                        if (!current || current.lease?.token !== token)
                            return;
                        current.publication = { stage: "committed", skillId: plannedSkillId, path: published.skill.path, sha256: published.skill.sha256, updatedAt: Date.now() };
                    });
                    return this.complete(job, token, recovered, "saved");
                }
            }
            const message = error instanceof Error ? error.message : String(error);
            const code = signal.aborted ? stopCode(signal) : error instanceof Stop ? error.code : error instanceof SkillConflictError ? "skill_conflict" : phase === "validation" ? "candidate_invalid" : "review_failed";
            const cancelled = ["user_cancelled", "execution_interrupted", "lease_lost"].includes(code);
            const transient = ["review_timeout", "host_unloaded", "project_daily_budget"].includes(code) || phase === "provider" && /(?:429|408|5\d\d|network|timeout|timed out|unavailable|overload|connection|ECONN|fetch failed)/i.test(message);
            const retry = transient && (job.attempts < this.options.maxAttempts || code === "host_unloaded");
            const at = code === "project_daily_budget" ? nextDay() : Date.now() + Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** Math.max(0, job.attempts - 1));
            const value = result(cancelled ? "cancelled" : code === "skill_conflict" ? "skipped" : retry ? "queued" : "failed", code, cancelled ? "Review was cancelled before publication." : code === "skill_conflict" ? "Skill changed, is pinned, or conflicts with existing ownership; current content was preserved." : code === "candidate_invalid" ? `Candidate rejected: ${truncate(message, 400)}` : retry ? "Temporary review failure; a durable retry is scheduled." : "Review failed; inspect status and provider diagnostics.", { taskId: id, nextRunAt: retry ? at : undefined });
            return this.complete(job, token, value, cancelled ? "cancelled" : code === "skill_conflict" ? "skipped" : retry ? "retry" : "failed", retry ? at : undefined);
        }
    }
    async status() {
        try {
            await this.ready;
            const state = await this.queue.read();
            const skills = await this.store.list();
            return { version: PLUGIN_VERSION, enabled: this.options.enabled, mode: this.options.mode, activeSession: this.active?.sessionId,
                reuse: await this.reuse.status(),
                screeningPolicy: { version: COMPLEXITY_POLICY_VERSION, minScore: this.options.minComplexityScore, callCountIsTrigger: false,
                    deprecatedOptions: ["minToolCalls", "minToolCallsWithErrors"], semanticReviewRequired: true },
                capabilities: state.capabilities, lastEventAt: state.lastEventAt, lastDecision: state.lastDecision,
                budget: { day: state.day, reviews: state.reviews, limit: this.options.maxReviewsPerDay, estimatedInputTokens: state.inputTokens ?? 0,
                    estimatedInputTokenLimit: this.options.maxEstimatedTokensPerDay, global: await this.global.read() },
                jobs: Object.values(state.jobs).map(({ id, sessionId, status, attempts, reasonCode, nextRunAt, publication, preScreen }) => ({ id, sessionId, status, attempts, reasonCode, nextRunAt, publication: publication?.stage,
                    preScreen: preScreen ? { eligible: preScreen.eligible, score: preScreen.score,
                        version: preScreen.version, dimensions: preScreen.dimensions,
                        reasonCodes: preScreen.reasonCodes } : undefined })),
                skills: skills.map(({ id, title, ownership, pinned, archived, usageCount, lastUsedAt, feedback }) => ({ id, title, ownership, pinned, archived, usageCount, lastUsedAt, feedback })),
                metrics: state.metrics, recent: state.recent.slice(-20), lastFailure: this.lastFailure };
        }
        catch {
            return { version: PLUGIN_VERSION, enabled: this.options.enabled, lastFailure: this.lastFailure ?? result("failed", "initialization_failed", "Runtime unavailable; run doctor.") };
        }
    }
    async prepareReuse(request) {
        await this.ready;
        request.signal?.throwIfAborted();
        if (!this.disposed)
            await this.reuse.prepare(request);
    }
    async reuseContext(sessionId, signal, messageId, queryHash) {
        await this.ready;
        signal?.throwIfAborted();
        if (!this.disposed)
            return this.reuse.context(sessionId, signal, messageId, queryHash);
    }
    async loadReuse(input) {
        await this.ready;
        input.signal?.throwIfAborted();
        if (this.disposed)
            return { status: "disabled" };
        return this.reuse.load(input);
    }
    async searchReuse(input) {
        await this.ready;
        input.signal?.throwIfAborted();
        if (this.disposed)
            return { status: "disabled" };
        return this.reuse.search(input);
    }
    async reuseFeedback(input) {
        await this.ready;
        input.signal?.throwIfAborted();
        if (this.disposed)
            return { status: "disabled" };
        return this.reuse.feedback(input);
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.timer)
            clearTimeout(this.timer);
        for (const controller of this.controllers)
            controller.abort(new Stop("host_unloaded"));
        this.active?.controller.abort(new Stop("host_unloaded"));
        await Promise.allSettled([...this.collections, ...(this.active ? [this.active.promise] : []), this.ready]);
        await this.queue?.close();
        await this.global?.close();
        await this.reuse?.close();
    }
}
//# sourceMappingURL=engine.js.map