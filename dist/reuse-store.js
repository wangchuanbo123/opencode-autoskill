import * as path from "node:path";
import { createHash } from "node:crypto";
import { openSqlite, beginImmediate, assertSqliteFiles } from "./sqlite.js";
import { ensurePrivateDirectory } from "./state.js";
import { resolveStorageLayout } from "./storage-layout.js";
function identifier(value, label) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value))
        throw new Error(`Invalid reuse ${label}.`);
}
function skillIdentity(input) {
    taskKey(input);
    if (typeof input.skillId !== "string" || input.skillId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.skillId))
        throw new Error("Invalid reuse skill id.");
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
        throw new Error("A reuse record requires a skill content hash.");
}
export function reuseTaskId(input) { return taskKey(input); }
function taskKey(input) {
    identifier(input.sessionId, "session id");
    identifier(input.anchorId, "anchor id");
    if (input.queryHash !== undefined && !/^[a-f0-9]{64}$/.test(input.queryHash))
        throw new Error("Invalid reuse query hash.");
    return createHash("sha256").update(JSON.stringify(input.queryHash === undefined ? [input.sessionId, input.anchorId] : [input.sessionId, input.anchorId, input.queryHash])).digest("hex");
}
function source(value) {
    if (value !== "user" && value !== "model")
        throw new Error("Reuse feedback must identify its reporting source.");
}
function skillRecord(row) {
    return { skillId: row.skill_id, sha256: row.sha256, offered: !!row.offered, score: row.score ?? undefined,
        reasonCodes: JSON.parse(row.reasons), loaded: !!row.loaded, loadSource: row.load_source ?? undefined,
        nativeLoadObserved: !!row.native_loaded, used: !!row.used, useSource: row.use_source ?? undefined,
        feedback: row.feedback, feedbackSource: row.feedback_source ?? undefined, userFeedback: row.user_feedback ?? undefined, modelFeedback: row.model_feedback ?? undefined };
}
/** Private, version-specific task ledger. Task outcome is never converted into causal skill feedback. */
export class ReuseStore {
    root;
    file;
    opening;
    serial = Promise.resolve();
    closing;
    constructor(root) {
        this.root = root;
        this.file = path.join(resolveStorageLayout(root).stateRoot, "reuse.sqlite");
    }
    async database() {
        this.opening ??= (async () => {
            const db = await openSqlite(this.file, () => ensurePrivateDirectory(this.root));
            try {
                if (!await beginImmediate(db))
                    throw new Error("Reuse ledger is busy.");
                try {
                    db.exec(`CREATE TABLE IF NOT EXISTS reuse_tasks (
            id TEXT PRIMARY KEY, session_id TEXT, anchor_id TEXT, query_hash TEXT, excluded_ids TEXT NOT NULL DEFAULT '[]', searched INTEGER NOT NULL DEFAULT 0, policy TEXT, outcome TEXT NOT NULL DEFAULT 'unknown', outcome_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, compacted INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS reuse_skills (
            task_id TEXT NOT NULL REFERENCES reuse_tasks(id), skill_id TEXT NOT NULL, sha256 TEXT NOT NULL,
            offered INTEGER NOT NULL DEFAULT 0, score REAL, reasons TEXT NOT NULL DEFAULT '[]',
            loaded INTEGER NOT NULL DEFAULT 0, load_source TEXT, loaded_at INTEGER,
            native_loaded INTEGER NOT NULL DEFAULT 0, native_tool_hash TEXT, used INTEGER NOT NULL DEFAULT 0, use_source TEXT,
            feedback TEXT NOT NULL DEFAULT 'unknown', feedback_source TEXT, user_feedback TEXT, model_feedback TEXT,
            PRIMARY KEY (task_id, skill_id, sha256)
          );
          CREATE INDEX IF NOT EXISTS reuse_skills_version ON reuse_skills(skill_id,sha256);
          CREATE INDEX IF NOT EXISTS reuse_tasks_recent ON reuse_tasks(updated_at);`);
                    const columns = new Set(db.prepare("PRAGMA table_info(reuse_tasks)").all().map((row) => row.name));
                    if (!columns.has("session_id"))
                        db.exec("ALTER TABLE reuse_tasks ADD COLUMN session_id TEXT;");
                    if (!columns.has("anchor_id"))
                        db.exec("ALTER TABLE reuse_tasks ADD COLUMN anchor_id TEXT;");
                    if (!columns.has("query_hash"))
                        db.exec("ALTER TABLE reuse_tasks ADD COLUMN query_hash TEXT;");
                    if (!columns.has("excluded_ids"))
                        db.exec("ALTER TABLE reuse_tasks ADD COLUMN excluded_ids TEXT NOT NULL DEFAULT '[]';");
                    if (!columns.has("outcome_at"))
                        db.exec("ALTER TABLE reuse_tasks ADD COLUMN outcome_at INTEGER NOT NULL DEFAULT 0;");
                    const skillColumns = new Set(db.prepare("PRAGMA table_info(reuse_skills)").all().map((row) => row.name));
                    if (!skillColumns.has("user_feedback"))
                        db.exec("ALTER TABLE reuse_skills ADD COLUMN user_feedback TEXT;");
                    if (!skillColumns.has("model_feedback"))
                        db.exec("ALTER TABLE reuse_skills ADD COLUMN model_feedback TEXT;");
                    db.exec("UPDATE reuse_skills SET user_feedback=feedback WHERE feedback_source='user' AND user_feedback IS NULL; UPDATE reuse_skills SET model_feedback=feedback WHERE feedback_source='model' AND model_feedback IS NULL;");
                    db.exec("CREATE INDEX IF NOT EXISTS reuse_tasks_session ON reuse_tasks(session_id,created_at);");
                    db.exec("COMMIT");
                }
                catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                }
                return db;
            }
            catch (error) {
                db.close();
                throw error;
            }
        })().catch((error) => { this.opening = undefined; throw error; });
        return this.opening;
    }
    async transaction(mutate, signal, write = true) {
        if (this.closing)
            throw new Error("Reuse ledger is closed.");
        const run = this.serial.then(async () => {
            signal?.throwIfAborted();
            const db = await this.database();
            await ensurePrivateDirectory(this.root);
            await assertSqliteFiles(this.file);
            signal?.throwIfAborted();
            if (write) {
                if (!await beginImmediate(db))
                    throw new Error("Reuse ledger is busy.");
            }
            else
                db.exec("BEGIN");
            try {
                signal?.throwIfAborted();
                const value = mutate(db);
                signal?.throwIfAborted();
                db.exec("COMMIT");
                return value;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        });
        this.serial = run.catch(() => undefined);
        return run;
    }
    ensureTask(db, identity) {
        const id = this.resolveTaskId(db, identity), now = Date.now();
        db.prepare("INSERT OR IGNORE INTO reuse_tasks(id,session_id,anchor_id,query_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, identity.sessionId, identity.anchorId, identity.queryHash ?? null, now, now);
        return id;
    }
    resolveTaskId(db, identity) {
        const id = taskKey(identity);
        if (identity.queryHash !== undefined)
            return id;
        const row = db.prepare("SELECT id FROM reuse_tasks WHERE session_id=? AND anchor_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
            .get(identity.sessionId, identity.anchorId);
        return row?.id ?? id;
    }
    ensureSkill(db, input) {
        const id = this.ensureTask(db, input);
        const existing = db.prepare("SELECT 1 FROM reuse_skills WHERE task_id=? AND skill_id=? AND sha256=?").get(id, input.skillId, input.sha256);
        if (!existing) {
            const task = db.prepare("SELECT compacted FROM reuse_tasks WHERE id=?").get(id);
            const count = db.prepare("SELECT COUNT(*) AS n FROM reuse_skills WHERE task_id=?").get(id);
            if (task.compacted || count.n >= 40)
                throw new Error("Reuse task history is compacted or its version limit was reached; start a new task.");
        }
        db.prepare("INSERT OR IGNORE INTO reuse_skills(task_id,skill_id,sha256) VALUES (?,?,?)").run(id, input.skillId, input.sha256);
        return id;
    }
    touch(db, taskId) { db.prepare("UPDATE reuse_tasks SET updated_at=? WHERE id=?").run(Date.now(), taskId); }
    readTask(db, id) {
        const row = db.prepare("SELECT * FROM reuse_tasks WHERE id=?").get(id);
        if (!row)
            return undefined;
        return { taskId: row.id, sessionId: row.session_id ?? undefined, anchorId: row.anchor_id ?? undefined, queryHash: row.query_hash ?? undefined,
            searched: !!row.searched, policyVersion: row.policy ?? undefined, outcome: row.outcome, outcomeAt: row.outcome_at || undefined,
            excludedSkillIds: (() => { try {
                const ids = JSON.parse(row.excluded_ids ?? "[]");
                return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
            }
            catch {
                return [];
            } })(),
            createdAt: row.created_at, updatedAt: row.updated_at, compacted: !!row.compacted,
            skills: db.prepare("SELECT * FROM reuse_skills WHERE task_id=? ORDER BY offered DESC,score DESC,skill_id,sha256").all(id).map(skillRecord) };
    }
    async recordSearch(input, signal) {
        taskKey(input);
        if (!Array.isArray(input.candidates) || input.candidates.length > 20)
            throw new Error("Reuse search requires at most twenty candidate summaries.");
        const excluded = input.excludedSkillIds ?? [];
        if (!Array.isArray(excluded) || excluded.length > 10_000 || excluded.some((id) => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)))
            throw new Error("Invalid excluded reuse skill ids.");
        if (input.policyVersion !== undefined && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(input.policyVersion))
            throw new Error("Invalid reuse policy version.");
        for (const candidate of input.candidates) {
            skillIdentity({ ...input, ...candidate });
            if (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1_000_000)
                throw new Error("Invalid reuse score.");
            if (candidate.reasonCodes && (candidate.reasonCodes.length > 12 || candidate.reasonCodes.some((code) => !/^[a-z][a-z0-9_-]{0,63}$/.test(code))))
                throw new Error("Invalid reuse reason codes.");
        }
        return this.transaction((db) => {
            const id = this.ensureTask(db, input);
            const prior = this.readTask(db, id);
            const existing = new Set(prior.excludedSkillIds);
            for (const skillId of excluded)
                existing.add(skillId);
            db.prepare("UPDATE reuse_tasks SET excluded_ids=? WHERE id=?").run(JSON.stringify([...existing].slice(0, 10_000)), id);
            if (prior.compacted)
                return this.readTask(db, id);
            db.prepare("UPDATE reuse_tasks SET searched=1,policy=COALESCE(policy,?) WHERE id=?").run(input.policyVersion ?? null, id);
            for (const candidate of input.candidates) {
                this.ensureSkill(db, { ...input, ...candidate });
                db.prepare("UPDATE reuse_skills SET offered=1,score=?,reasons=? WHERE task_id=? AND skill_id=? AND sha256=?")
                    .run(candidate.score, JSON.stringify(candidate.reasonCodes ?? []), id, candidate.skillId, candidate.sha256);
            }
            this.touch(db, id);
            return this.readTask(db, id);
        }, signal);
    }
    async recordLoad(input, signal) {
        skillIdentity(input);
        if (input.source !== "automatic" && input.source !== "explicit")
            throw new Error("Invalid reuse load source.");
        if (input.maxLoaded !== undefined && (!Number.isInteger(input.maxLoaded) || input.maxLoaded < 1 || input.maxLoaded > 20))
            throw new Error("Invalid reuse task load limit.");
        return this.transaction((db) => {
            const id = this.ensureSkill(db, input);
            const existing = db.prepare("SELECT loaded FROM reuse_skills WHERE task_id=? AND skill_id=? AND sha256=?").get(id, input.skillId, input.sha256);
            if (!existing?.loaded && input.maxLoaded !== undefined) {
                const loaded = db.prepare("SELECT COUNT(*) AS count FROM reuse_skills WHERE task_id=? AND loaded=1").get(id);
                if (loaded.count >= input.maxLoaded)
                    throw new Error("Reuse task load limit reached.");
            }
            db.prepare("UPDATE reuse_skills SET loaded=1,load_source=COALESCE(load_source,?),loaded_at=COALESCE(loaded_at,?) WHERE task_id=? AND skill_id=? AND sha256=?")
                .run(input.source, Date.now(), id, input.skillId, input.sha256);
            this.touch(db, id);
            return this.readTask(db, id);
        }, signal);
    }
    async observeNativeLoad(input, signal) {
        skillIdentity(input);
        identifier(input.toolCallId, "tool call id");
        return this.transaction((db) => {
            const id = this.ensureSkill(db, input);
            const toolHash = createHash("sha256").update(input.toolCallId).digest("hex");
            db.prepare("UPDATE reuse_skills SET loaded=1,load_source=COALESCE(load_source,'native'),loaded_at=COALESCE(loaded_at,?),native_loaded=1,native_tool_hash=COALESCE(native_tool_hash,?) WHERE task_id=? AND skill_id=? AND sha256=?")
                .run(Date.now(), toolHash, id, input.skillId, input.sha256);
            this.touch(db, id);
            return this.readTask(db, id);
        }, signal);
    }
    async recordUse(input, signal) {
        skillIdentity(input);
        source(input.source);
        return this.transaction((db) => {
            const id = this.resolveTaskId(db, input), row = db.prepare("SELECT loaded FROM reuse_skills WHERE task_id=? AND skill_id=? AND sha256=?").get(id, input.skillId, input.sha256);
            if (!row?.loaded)
                throw new Error("A skill must be loaded before reporting application.");
            db.prepare("UPDATE reuse_skills SET used=1,use_source=CASE WHEN use_source='user' THEN 'user' ELSE ? END WHERE task_id=? AND skill_id=? AND sha256=?")
                .run(input.source, id, input.skillId, input.sha256);
            this.touch(db, id);
            return this.readTask(db, id);
        }, signal);
    }
    async finishTask(input, signal) {
        taskKey(input);
        if (!["success", "failure", "interrupted", "unknown"].includes(input.outcome))
            throw new Error("Invalid reuse task outcome.");
        const at = input.finishedAt ?? Date.now();
        if (!Number.isSafeInteger(at) || at < 0)
            throw new Error("Invalid reuse task outcome time.");
        return this.transaction((db) => {
            const id = this.resolveTaskId(db, input);
            db.prepare("UPDATE reuse_tasks SET outcome=?,outcome_at=?,updated_at=? WHERE id=? AND outcome_at<=?").run(input.outcome, at, Date.now(), id, at);
            return this.readTask(db, id);
        }, signal);
    }
    /** Explicit skill feedback stays separate from task outcome and retains its reporting source. */
    async feedback(input, signal) {
        skillIdentity(input);
        source(input.source);
        if (!["success", "failure", "unknown"].includes(input.outcome))
            throw new Error("Invalid reuse feedback outcome.");
        return this.transaction((db) => {
            const id = this.resolveTaskId(db, input), row = db.prepare("SELECT loaded FROM reuse_skills WHERE task_id=? AND skill_id=? AND sha256=?").get(id, input.skillId, input.sha256);
            if (!row?.loaded)
                throw new Error("Feedback requires a previously loaded skill version.");
            const column = input.source === "user" ? "user_feedback" : "model_feedback";
            db.prepare(`UPDATE reuse_skills SET ${column}=?,
        feedback=CASE WHEN ?='user' OR user_feedback IS NULL THEN ? ELSE feedback END,
        feedback_source=CASE WHEN ?='user' OR user_feedback IS NULL THEN ? ELSE feedback_source END,
        used=CASE WHEN ?='unknown' THEN used ELSE 1 END,
        use_source=CASE WHEN ?='unknown' OR use_source='user' THEN use_source ELSE ? END
        WHERE task_id=? AND skill_id=? AND sha256=?`)
                .run(input.outcome, input.source, input.outcome, input.source, input.source, input.outcome, input.outcome, input.source, id, input.skillId, input.sha256);
            this.touch(db, id);
            return this.readTask(db, id);
        }, signal);
    }
    async inspect(identity) {
        taskKey(identity);
        return this.transaction((db) => this.readTask(db, this.resolveTaskId(db, identity)), undefined, false);
    }
    async getTask(identity) { return this.inspect(identity); }
    async currentTask(sessionId) {
        identifier(sessionId, "session id");
        return this.transaction((db) => {
            const row = db.prepare("SELECT id FROM reuse_tasks WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(sessionId);
            return row ? this.readTask(db, row.id) : undefined;
        }, undefined, false);
    }
    async history(skillId, sha256) {
        if (skillId !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId))
            throw new Error("Invalid reuse skill id.");
        if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256))
            throw new Error("Invalid reuse skill hash.");
        return this.transaction((db) => {
            const where = [skillId ? "s.skill_id=?" : "", sha256 ? "s.sha256=?" : ""].filter(Boolean).join(" AND ");
            const values = [skillId, sha256].filter((value) => value !== undefined);
            const rows = db.prepare(`SELECT s.skill_id,s.sha256,SUM(offered) AS offered,SUM(loaded) AS loaded,SUM(native_loaded) AS native_loaded,SUM(used) AS used,
        SUM(CASE WHEN feedback='success' THEN 1 ELSE 0 END) AS success,SUM(CASE WHEN feedback='failure' THEN 1 ELSE 0 END) AS failure,
        SUM(CASE WHEN loaded=1 AND feedback='unknown' THEN 1 ELSE 0 END) AS unknown,
        SUM(CASE WHEN user_feedback='success' THEN 1 ELSE 0 END) AS user_success,
        SUM(CASE WHEN user_feedback='failure' THEN 1 ELSE 0 END) AS user_failure,
        SUM(CASE WHEN model_feedback='success' THEN 1 ELSE 0 END) AS model_success,
        SUM(CASE WHEN model_feedback='failure' THEN 1 ELSE 0 END) AS model_failure,
        SUM(CASE WHEN loaded=1 AND t.outcome='success' THEN 1 ELSE 0 END) AS task_success,
        SUM(CASE WHEN loaded=1 AND t.outcome='failure' THEN 1 ELSE 0 END) AS task_failure,
        SUM(CASE WHEN loaded=1 AND t.outcome='interrupted' THEN 1 ELSE 0 END) AS task_interrupted,
        SUM(CASE WHEN loaded=1 AND t.outcome='unknown' THEN 1 ELSE 0 END) AS task_unknown,MAX(loaded_at) AS last_loaded
        FROM reuse_skills s JOIN reuse_tasks t ON s.task_id=t.id ${where ? `WHERE ${where}` : ""} GROUP BY s.skill_id,s.sha256 ORDER BY s.skill_id,s.sha256`).all(...values);
            return rows.map((row) => ({ skillId: String(row.skill_id), sha256: String(row.sha256), offered: Number(row.offered), loaded: Number(row.loaded),
                nativeLoaded: Number(row.native_loaded), reportedUsed: Number(row.used), feedback: { success: Number(row.success), failure: Number(row.failure), unknown: Number(row.unknown) },
                userFeedback: { success: Number(row.user_success), failure: Number(row.user_failure) }, modelFeedback: { success: Number(row.model_success), failure: Number(row.model_failure) },
                taskOutcomes: { success: Number(row.task_success), failure: Number(row.task_failure), interrupted: Number(row.task_interrupted), unknown: Number(row.task_unknown) },
                lastLoadedAt: row.last_loaded === null ? undefined : Number(row.last_loaded) }));
        }, undefined, false);
    }
    async status(limit = 20) {
        if (!Number.isInteger(limit) || limit < 0 || limit > 100)
            throw new Error("Reuse status limit must be between zero and one hundred.");
        return this.transaction((db) => {
            const counts = db.prepare(`SELECT SUM(searched) AS searched,(SELECT COUNT(DISTINCT task_id) FROM reuse_skills WHERE loaded=1) AS loaded,
        (SELECT COUNT(DISTINCT task_id) FROM reuse_skills WHERE used=1) AS used FROM reuse_tasks`).get();
            const rows = db.prepare("SELECT id FROM reuse_tasks ORDER BY updated_at DESC,id LIMIT ?").all(limit);
            return { searchedTasks: counts.searched ?? 0, loadedTasks: counts.loaded, reportedUsedTasks: counts.used, recent: rows.map((row) => this.readTask(db, row.id)) };
        }, undefined, false);
    }
    /** Bound detailed history; tiny version/stage/feedback tombstones retain deduplication and aggregates. */
    async compact(options = {}, signal) {
        const keep = options.keepRecentTasks ?? 1_000, days = options.olderThanDays ?? 30;
        if (!Number.isInteger(keep) || keep < 0 || !Number.isFinite(days) || days < 0)
            throw new Error("Invalid reuse history retention.");
        return this.transaction((db) => {
            const rows = db.prepare("SELECT id FROM reuse_tasks WHERE compacted=0 AND outcome<>'unknown' AND updated_at<? AND id NOT IN (SELECT id FROM reuse_tasks ORDER BY updated_at DESC,id LIMIT ?)")
                .all(Date.now() - days * 86_400_000, keep);
            for (const row of rows) {
                db.prepare("UPDATE reuse_skills SET score=NULL,reasons='[]',native_tool_hash=NULL WHERE task_id=?").run(row.id);
                db.prepare("UPDATE reuse_tasks SET compacted=1,policy=NULL WHERE id=?").run(row.id);
            }
            return rows.length;
        }, signal);
    }
    async close() {
        this.closing ??= (async () => { await this.serial; const db = await this.opening; db?.close(); })();
        return this.closing;
    }
}
//# sourceMappingURL=reuse-store.js.map