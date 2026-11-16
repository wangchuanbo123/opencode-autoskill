import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { openSqlite, beginImmediate, realDirectoryTree, assertSqliteFiles } from "./sqlite.js";
import { ensurePrivateDirectory, ensurePrivateIgnore, emptyState, validateRuntimeState, regularStateFile, atomicStateJson, StateStore } from "./state.js";
import { resolveStorageLayout } from "./storage-layout.js";
function initialQueueState() { return { ...emptyState(), version: 2, jobs: {}, metrics: {} }; }
const terminal = new Set(["saved", "skipped", "failed", "draft", "cancelled"]);
const statuses = new Set([...terminal, "pending", "running", "retry"]);
function validateJob(value, id) {
    const job = value;
    if (!job || typeof job !== "object" || job.id !== id || typeof job.sessionId !== "string" || !job.sessionId ||
        typeof job.fingerprint !== "string" || !statuses.has(job.status) || !Number.isInteger(job.attempts) || job.attempts < 0 ||
        !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt) || !Number.isFinite(job.nextRunAt)) {
        throw new Error("Invalid persistent AutoSkill job; inspect runtime data before recovery.");
    }
    if (job.lease && (!Number.isSafeInteger(job.lease.pid) || job.lease.pid <= 0 || !Number.isFinite(job.lease.expiresAt) ||
        typeof job.lease.token !== "string" || !job.lease.token))
        throw new Error("Invalid persistent AutoSkill job lease.");
    return job;
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
/** Durable queue with brief SQLite transactions. Never await model/network work inside transaction(). */
export class QueueStore {
    root;
    directory;
    file;
    opening;
    serial = Promise.resolve();
    closed = false;
    diagnosticError;
    constructor(root) {
        this.root = root;
        this.directory = resolveStorageLayout(root).stateRoot;
        this.file = path.join(this.directory, "runtime.sqlite");
    }
    async database() {
        if (this.closed)
            throw new Error("AutoSkill queue is closed.");
        this.opening ??= (async () => {
            const database = await openSqlite(this.file, () => ensurePrivateDirectory(this.root));
            try {
                if (!await beginImmediate(database))
                    throw new Error("AutoSkill queue is busy.");
                try {
                    database.exec("CREATE TABLE IF NOT EXISTS runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL);");
                    const row = database.prepare("SELECT value FROM runtime WHERE key='state'").get();
                    if (!row) {
                        let state = initialQueueState();
                        const legacy = path.join(this.directory, "state.json");
                        if (await regularStateFile(legacy)) {
                            const old = validateRuntimeState(JSON.parse(await fs.readFile(legacy, "utf8")));
                            state = { ...old, version: 2, jobs: {}, metrics: {} };
                        }
                        database.prepare("INSERT INTO runtime(key,value) VALUES ('state',?)").run(JSON.stringify(state));
                    }
                    database.exec("COMMIT");
                    return database;
                }
                catch (error) {
                    database.exec("ROLLBACK");
                    throw error;
                }
            }
            catch (error) {
                database.close();
                throw error;
            }
        })().catch((error) => { this.opening = undefined; throw error; });
        return this.opening;
    }
    state(database) {
        const row = database.prepare("SELECT value FROM runtime WHERE key='state'").get();
        if (!row)
            throw new Error("Missing AutoSkill runtime state.");
        const metadata = JSON.parse(row.value);
        const base = validateRuntimeState(metadata);
        const jobs = Object.fromEntries(database.prepare("SELECT id,value FROM jobs").all().map((item) => {
            const row = item;
            return [row.id, validateJob(JSON.parse(row.value), row.id)];
        }));
        return { ...metadata, ...base, version: 2, jobs };
    }
    async read() {
        const run = this.serial.then(async () => {
            const database = await this.database();
            await ensurePrivateDirectory(this.root);
            await assertSqliteFiles(this.file);
            database.exec("BEGIN");
            try {
                const state = this.state(database);
                database.exec("COMMIT");
                if (this.diagnosticError)
                    state.metrics = { ...state.metrics, diagnosticExportFailures: 1 };
                return state;
            }
            catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        });
        this.serial = run.catch(() => undefined);
        return run;
    }
    async transaction(change) {
        const run = this.serial.then(async () => {
            const database = await this.database();
            await ensurePrivateDirectory(this.root);
            await assertSqliteFiles(this.file);
            if (!await beginImmediate(database))
                throw new Error("AutoSkill queue is busy.");
            let value;
            let state;
            try {
                state = this.state(database);
                const prior = new Map(Object.entries(state.jobs).map(([id, job]) => [id, JSON.stringify(job)]));
                value = change(state);
                if (value && typeof value === "object" && "then" in value)
                    throw new Error("AutoSkill queue transaction callbacks must be synchronous.");
                state.version = 2;
                state.recent = state.recent.slice(-200);
                state.sessions = Object.fromEntries(Object.entries(state.sessions).slice(-1_000));
                state.attempts = Object.fromEntries(Object.entries(state.attempts).slice(-5_000));
                // Keep stable ID/fingerprint tombstones so replaying a long session never
                // re-creates completed jobs. Only old, terminal transcript payloads expire.
                const old = Object.values(state.jobs).filter((job) => terminal.has(job.status) && job.status !== "draft").sort((a, b) => b.updatedAt - a.updatedAt).slice(500);
                for (const job of old) {
                    delete job.snapshot;
                    delete job.draftDecision;
                }
                for (const [id, job] of Object.entries(state.jobs)) {
                    validateJob(job, id);
                    const encoded = JSON.stringify(job);
                    if (encoded.length > 4_000_000)
                        throw new Error("AutoSkill job payload exceeds the durable storage budget.");
                    if (prior.get(id) !== encoded)
                        database.prepare("INSERT INTO jobs(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, encoded);
                    prior.delete(id);
                }
                for (const id of prior.keys())
                    database.prepare("DELETE FROM jobs WHERE id=?").run(id);
                const { jobs: _jobs, ...metadata } = state;
                database.prepare("UPDATE runtime SET value=? WHERE key='state'").run(JSON.stringify(metadata));
                database.exec("COMMIT");
            }
            catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
            // JSON is a diagnostic projection, never the source of queue consistency.
            try {
                await ensurePrivateDirectory(this.root);
                const jobs = Object.fromEntries(Object.entries(state.jobs).map(([id, job]) => {
                    const { snapshot: _snapshot, ...metadata } = job;
                    return [id, metadata];
                }));
                await atomicStateJson(path.join(this.directory, "state.json"), { ...state, jobs });
                this.diagnosticError = undefined;
            }
            catch {
                this.diagnosticError = "AutoSkill diagnostic export could not be written; SQLite state remains authoritative.";
            }
            return value;
        });
        this.serial = run.catch(() => undefined);
        return run;
    }
    async upsert(job) {
        return this.transaction((state) => {
            const current = state.jobs[job.id];
            if (current && current.fingerprint === job.fingerprint)
                return { inserted: false, job: current };
            if (current?.status === "running" && current.lease && current.lease.expiresAt > Date.now() && alive(current.lease.pid)) {
                throw new Error("Cannot replace evidence owned by an active review.");
            }
            state.jobs[job.id] = job;
            state.lastEventAt = Date.now();
            return { inserted: true, job };
        });
    }
    async claim(jobId, leaseMs = 120_000) {
        return this.transaction((state) => {
            const now = Date.now();
            const job = (jobId ? [state.jobs[jobId]] : Object.values(state.jobs).sort((a, b) => a.nextRunAt - b.nextRunAt || a.createdAt - b.createdAt))
                .find((candidate) => candidate && ["pending", "retry"].includes(candidate.status) && candidate.nextRunAt <= now);
            if (!job)
                return undefined;
            job.status = "running";
            job.lease = { token: randomUUID(), pid: process.pid, expiresAt: now + Math.max(1_000, leaseMs) };
            job.updatedAt = now;
            return job;
        });
    }
    async finish(jobId, token, result, status, publication) {
        return this.transaction((state) => {
            const job = state.jobs[jobId];
            if (!job || job.status !== "running" || job.lease?.token !== token || job.lease.expiresAt <= Date.now())
                return false;
            job.status = status;
            job.result = result;
            job.publication = publication ?? job.publication;
            job.updatedAt = Date.now();
            delete job.lease;
            state.recent.push({ at: new Date().toISOString(), sessionId: job.sessionId, jobId, result, reasonCode: job.reasonCode });
            return true;
        });
    }
    async recover() {
        return this.transaction((state) => {
            let recovered = 0;
            const publications = [];
            const now = Date.now();
            for (const job of Object.values(state.jobs)) {
                if (job.status === "running" && (!job.lease || job.lease.expiresAt <= now || !alive(job.lease.pid))) {
                    job.status = "retry";
                    job.nextRunAt = now;
                    job.updatedAt = now;
                    job.reasonCode = "recovered_interrupted_review";
                    delete job.lease;
                    recovered++;
                }
                if (job.publication && job.publication.stage !== "committed")
                    publications.push(job);
            }
            return { recovered, publications };
        });
    }
    async record(sessionId, result, reasonCode, jobId) {
        await this.transaction((state) => {
            const at = Date.now();
            state.lastEventAt = at;
            state.lastDecision = { at, sessionId, jobId, reasonCode, result };
            state.metrics ??= {};
            state.metrics[reasonCode] = (state.metrics[reasonCode] ?? 0) + 1;
            state.recent.push({ at: new Date(at).toISOString(), sessionId, result, reasonCode, jobId });
        });
        try {
            await new StateStore(this.root).record(sessionId, result, reasonCode, jobId);
        }
        catch {
            this.diagnosticError = "AutoSkill event journal could not be written; SQLite state remains authoritative.";
        }
    }
    async close() {
        await this.serial;
        if (this.closed)
            return;
        this.closed = true;
        const database = await this.opening?.catch(() => undefined);
        database?.close();
    }
}
export function privateStateHome() {
    return path.resolve(process.env.AUTOSKILL_STATE_HOME ?? (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "opencode-autoskill") : path.join(os.homedir(), ".local", "state", "opencode-autoskill")));
}
/** A shared private counter across projects; conservative reservation precedes provider calls. */
export class GlobalBudgetStore {
    directory;
    opening;
    serial = Promise.resolve();
    closed = false;
    constructor(directory = privateStateHome()) { this.directory = path.resolve(directory); }
    async prepare() {
        await realDirectoryTree(path.parse(this.directory).root, this.directory);
        await ensurePrivateIgnore(this.directory);
        await assertSqliteFiles(path.join(this.directory, "budget.sqlite"));
    }
    async database() {
        if (this.closed)
            throw new Error("Global AutoSkill budget is closed.");
        this.opening ??= (async () => {
            const database = await openSqlite(path.join(this.directory, "budget.sqlite"), () => this.prepare());
            if (!await beginImmediate(database)) {
                database.close();
                throw new Error("Global AutoSkill budget is busy.");
            }
            try {
                database.exec("CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, day TEXT NOT NULL);");
                database.exec("COMMIT");
            }
            catch (error) {
                database.exec("ROLLBACK");
                database.close();
                throw error;
            }
            return database;
        })().catch((error) => { this.opening = undefined; throw error; });
        return this.opening;
    }
    usage(database) {
        const day = new Date().toISOString().slice(0, 10);
        const row = database.prepare("SELECT value FROM budget WHERE day=?").get(day);
        const usage = row ? JSON.parse(row.value) : { day, reviews: 0, inputTokens: 0 };
        if (usage.day !== day || !Number.isInteger(usage.reviews) || usage.reviews < 0 || !Number.isFinite(usage.inputTokens) || usage.inputTokens < 0)
            throw new Error("Invalid global AutoSkill budget; inspect the private budget database.");
        return usage;
    }
    async read() {
        const run = this.serial.then(async () => { const database = await this.database(); await this.prepare(); return this.usage(database); });
        this.serial = run.catch(() => undefined);
        return run;
    }
    async reserve(id, limits) {
        const run = this.serial.then(async () => {
            if (!id || id.length > 500 || !Number.isInteger(limits.maxReviewsPerDay) || limits.maxReviewsPerDay < 1 ||
                limits.estimatedInputTokens !== undefined && (!Number.isFinite(limits.estimatedInputTokens) || limits.estimatedInputTokens < 0) ||
                limits.maxInputTokensPerDay !== undefined && (!Number.isFinite(limits.maxInputTokensPerDay) || limits.maxInputTokensPerDay < 1))
                throw new Error("Invalid global budget reservation.");
            const database = await this.database();
            await this.prepare();
            if (!await beginImmediate(database))
                throw new Error("Global AutoSkill budget is busy.");
            try {
                const used = this.usage(database);
                const nextRunAt = Date.parse(`${used.day}T00:00:00.000Z`) + 86_400_000;
                const reservationKey = `${used.day}:${id}`;
                if (database.prepare("SELECT id FROM reservations WHERE id=?").get(reservationKey)) {
                    database.exec("COMMIT");
                    return { allowed: true, reasonCode: "budget_already_reserved", used, nextRunAt };
                }
                const tokens = Math.ceil(limits.estimatedInputTokens ?? 0);
                const denied = used.reviews >= limits.maxReviewsPerDay ? "global_daily_review_budget" :
                    limits.maxInputTokensPerDay !== undefined && used.inputTokens + tokens > limits.maxInputTokensPerDay ? "global_daily_input_budget" : undefined;
                if (denied) {
                    database.exec("COMMIT");
                    return { allowed: false, reasonCode: denied, used, nextRunAt };
                }
                used.reviews++;
                used.inputTokens += tokens;
                database.prepare("INSERT INTO budget(day,value) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET value=excluded.value").run(used.day, JSON.stringify(used));
                database.prepare("INSERT INTO reservations(id,day) VALUES (?,?)").run(reservationKey, used.day);
                const retainedDay = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
                database.prepare("DELETE FROM reservations WHERE day<?").run(retainedDay);
                database.prepare("DELETE FROM budget WHERE day<?").run(retainedDay);
                database.exec("COMMIT");
                return { allowed: true, reasonCode: "budget_reserved", used, nextRunAt };
            }
            catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        });
        this.serial = run.catch(() => undefined);
        return run;
    }
    async close() {
        await this.serial;
        if (this.closed)
            return;
        this.closed = true;
        (await this.opening?.catch(() => undefined))?.close();
    }
}
//# sourceMappingURL=jobs.js.map