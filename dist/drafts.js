import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireFileLock } from "./lock.js";
import { ensurePrivateDirectory } from "./state.js";
import { QueueStore } from "./jobs.js";
import { readOptions } from "./config.js";
import { parseDecision } from "./review.js";
import { SkillConflictError, SkillStore } from "./skills.js";
import { resolveStorageLayout } from "./storage-layout.js";
const MAX_DRAFT_BYTES = 2_000_000;
const MAX_DRAFTS = 2_000;
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function assertDraftId(id) {
    if (typeof id !== "string" || id.length < 1 || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "." || id === ".." ||
        !(/^[a-f0-9]{64}$/.test(id) || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) {
        throw new Error("Draft id must be a 64-character hex digest or portable lowercase kebab-case name.");
    }
}
function boundedString(value, label, max) {
    if (typeof value !== "string" || !value || value.length > max || value.includes("\0"))
        throw new Error(`Invalid draft ${label}.`);
}
function validateProvenance(value) {
    if (!isObject(value))
        throw new Error("Invalid draft provenance.");
    boundedString(value.sessionId, "provenance sessionId", 512);
    boundedString(value.fingerprint, "provenance fingerprint", 256);
    if (!Array.isArray(value.messageIds) || value.messageIds.length > 10_000 || value.messageIds.some((item) => typeof item !== "string" || item.length > 512))
        throw new Error("Invalid draft provenance messageIds.");
    if (!Array.isArray(value.evidence) || value.evidence.length > 100)
        throw new Error("Invalid draft provenance evidence.");
    boundedString(value.createdAt, "provenance createdAt", 100);
}
function validateEvidence(value) {
    if (!Array.isArray(value) || value.length > 500)
        throw new Error("Invalid draft evidence.");
    const ids = new Set();
    for (const item of value) {
        if (!isObject(item))
            throw new Error("Invalid draft tool evidence.");
        boundedString(item.id, "tool id", 256);
        boundedString(item.name, "tool name", 256);
        boundedString(item.output, "tool output", 500_000);
        if (item.status !== "completed" && item.status !== "error" && item.status !== "pending")
            throw new Error("Invalid draft tool status.");
        if (ids.has(item.id))
            throw new Error("Draft evidence contains duplicate tool ids.");
        ids.add(item.id);
    }
}
function validateRecord(value) {
    if (!isObject(value))
        throw new Error("Invalid draft record.");
    assertDraftId(value.id);
    if (!isObject(value.decision) || !isObject(value.provenance))
        throw new Error("Draft must contain decision and provenance.");
    validateProvenance(value.provenance);
    validateEvidence(value.evidence);
    if (value.expectedPreviousHash !== undefined && (typeof value.expectedPreviousHash !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedPreviousHash)))
        throw new Error("Invalid expectedPreviousHash.");
    if (value.options !== undefined && !isObject(value.options))
        throw new Error("Draft options must be an object.");
    if (value.createdAt !== undefined)
        boundedString(value.createdAt, "createdAt", 100);
    if (value.status !== undefined && !["draft", "published", "discarded"].includes(value.status))
        throw new Error("Invalid draft status.");
    if (value.published !== undefined && (!isObject(value.published) || typeof value.published.path !== "string" || !/^[a-f0-9]{64}$/.test(String(value.published.sha256)) || typeof value.published.version !== "string"))
        throw new Error("Invalid draft publication.");
}
function createdAt(value) {
    if (value !== undefined && Number.isFinite(Date.parse(value)))
        return value;
    return new Date().toISOString();
}
/** Private, reviewable candidates which can be published after explicit user approval. */
export class DraftStore {
    root;
    directory;
    lockDirectory;
    constructor(root) {
        this.root = path.resolve(root);
        this.directory = path.join(resolveStorageLayout(this.root).stateRoot, "drafts");
        this.lockDirectory = path.join(resolveStorageLayout(this.root).stateRoot, "locks");
    }
    async prepare() {
        await ensurePrivateDirectory(this.root);
        await this.realDirectory(this.directory, true);
        await this.realDirectory(this.lockDirectory, true);
    }
    async realDirectory(directory, create) {
        const root = resolveStorageLayout(this.root).stateRoot;
        const relative = path.relative(root, directory);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw new Error("Draft path escapes private storage.");
        let current = root;
        for (const part of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink() || !stat.isDirectory())
                    throw new Error("Unsafe draft storage directory.");
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                if (!create)
                    return;
                await fs.mkdir(current, { mode: 0o700 });
            }
        }
    }
    file(id) { assertDraftId(id); return path.join(this.directory, `${id}.json`); }
    async regular(file) {
        try {
            const stat = await fs.lstat(file);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DRAFT_BYTES)
                throw new Error("Unsafe or oversized draft file.");
            return true;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return false;
            throw error;
        }
    }
    async read(id) {
        const file = this.file(id);
        if (!await this.regular(file))
            return undefined;
        let value;
        try {
            value = JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch {
            throw new Error(`Draft ${id} is not valid JSON.`);
        }
        validateRecord(value);
        return value;
    }
    async atomic(file, value) {
        const text = JSON.stringify(value, null, 2) + "\n";
        if (Buffer.byteLength(text) > MAX_DRAFT_BYTES)
            throw new Error("Draft exceeds the private storage limit.");
        await this.realDirectory(path.dirname(file), true);
        if (await this.regular(file)) { /* regular() also rejects links */ }
        const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fs.open(temp, "wx", 0o600);
            await handle.writeFile(text, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(temp, file);
        }
        finally {
            await handle?.close();
            await fs.unlink(temp).catch(() => undefined);
        }
    }
    async withLock(id, fn) {
        await this.prepare();
        const release = await acquireFileLock(path.join(this.lockDirectory, `draft-${id}.lock`), () => this.prepare(), 5_000);
        if (!release)
            throw new SkillConflictError(`Draft ${id} is locked by another writer.`);
        try {
            return await fn();
        }
        finally {
            await release();
        }
    }
    async validate(record) {
        validateRecord(record);
        if (record.decision.action === "skip" || !record.decision.skill)
            throw new Error("Only create or update decisions with a skill can be drafted.");
        const options = readOptions(record.options ?? {});
        const skills = await new SkillStore(this.root).list();
        const decision = parseDecision(JSON.stringify(record.decision), new Map(record.evidence.map((tool) => [tool.id, tool])), skills, options, this.root);
        const normalized = { ...record, decision, createdAt: createdAt(record.createdAt), status: record.status ?? "draft" };
        return { record: normalized, options };
    }
    async create(input) {
        assertDraftId(input.id);
        return this.withLock(input.id, async () => {
            const existing = await this.read(input.id);
            if (existing) {
                if (existing.provenance.fingerprint === input.provenance.fingerprint && existing.provenance.taskId === input.provenance.taskId &&
                    existing.expectedPreviousHash === input.expectedPreviousHash && isDeepStrictEqual(existing.decision, input.decision) && isDeepStrictEqual(existing.evidence, input.evidence))
                    return existing;
                throw new SkillConflictError(`Draft ${input.id} already exists with different evidence or content.`);
            }
            const { record } = await this.validate({ ...input, status: "draft" });
            if (await new SkillStore(this.root).list().then((items) => items.some((item) => item.id === record.decision.skill?.id && record.decision.action === "create"))) {
                throw new SkillConflictError("Skill id already exists.");
            }
            await this.atomic(this.file(record.id), record);
            return record;
        });
    }
    async list() {
        await this.prepare();
        const entries = await fs.readdir(this.directory, { withFileTypes: true });
        const output = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
                continue;
            const id = entry.name.slice(0, -5);
            try {
                assertDraftId(id);
            }
            catch {
                continue;
            }
            const record = await this.read(id);
            if (!record)
                continue;
            output.push({ id, action: record.decision.action, skillId: record.decision.skill?.id,
                name: record.decision.skill?.name, reason: record.decision.reason, createdAt: createdAt(record.createdAt), status: record.status ?? "draft" });
        }
        if (output.length > MAX_DRAFTS)
            throw new Error("Too many AutoSkill drafts; inspect and remove stale drafts.");
        return output;
    }
    async inspect(id) {
        await this.prepare();
        const record = await this.read(id);
        if (!record)
            throw new Error(`Draft ${id} does not exist.`);
        // Inspect is deliberately a read-only operation: a published or conflicted
        // candidate must remain reviewable even when it no longer passes current
        // skill-collision checks. Creation and publication perform semantic validation.
        return record;
    }
    async queueUpdate(id, status, result, publication, expectedFingerprint) {
        const queue = new QueueStore(this.root);
        try {
            await queue.transaction((state) => {
                const job = state.jobs[id];
                if (!job)
                    return;
                if (expectedFingerprint !== undefined && job.fingerprint !== expectedFingerprint)
                    throw new SkillConflictError(`Queue job ${id} evidence no longer matches this draft.`);
                if (!["draft", "saved", "skipped"].includes(job.status))
                    throw new SkillConflictError(`Queue job ${id} is ${job.status}; refusing to overwrite it.`);
                job.status = status;
                job.result = result;
                job.publication = publication ?? job.publication;
                job.updatedAt = Date.now();
                delete job.lease;
            });
        }
        finally {
            await queue.close();
        }
    }
    async priorPublication(record, store) {
        const skillId = record.decision.skill?.id;
        if (!skillId)
            return undefined;
        try {
            const inspected = await store.inspect(skillId), source = inspected.provenance;
            if (source?.taskId !== record.id || source.fingerprint !== record.provenance.fingerprint || source.skillSha256 !== inspected.skill.sha256)
                return undefined;
            return { path: inspected.skill.path, id: skillId, changed: false, sha256: inspected.skill.sha256, version: source.version ?? inspected.skill.version ?? "unknown" };
        }
        catch {
            return undefined;
        }
    }
    async publish(id, publishOptions = {}) {
        return this.withLock(id, async () => {
            const record = await this.read(id);
            if (!record)
                throw new Error(`Draft ${id} does not exist.`);
            if (record.status === "discarded")
                throw new Error(`Draft ${id} was discarded.`);
            const store = new SkillStore(this.root);
            let checked;
            let options;
            try {
                ({ record: checked, options } = await this.validate(record));
            }
            catch (error) {
                const recovered = await this.priorPublication(record, store);
                if (!recovered)
                    throw error;
                await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft publication was already committed.", skillId: recovered.id, path: recovered.path, taskId: id }, { stage: "committed", ...recovered, updatedAt: Date.now() }, record.provenance.fingerprint);
                return { ...recovered, jobId: id };
            }
            const skill = await store.list().then((items) => items.find((item) => item.id === checked.decision.skill?.id));
            if (checked.expectedPreviousHash !== undefined && skill?.sha256 !== checked.expectedPreviousHash) {
                const recovered = await this.priorPublication(checked, store);
                if (!recovered)
                    throw new SkillConflictError("Skill changed since this draft was created.");
                await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft publication was already committed.", skillId: recovered.id, path: recovered.path, taskId: id }, { stage: "committed", ...recovered, updatedAt: Date.now() }, checked.provenance.fingerprint);
                return { ...recovered, jobId: id };
            }
            const provenance = { ...checked.provenance, taskId: id };
            const saved = await store.save(checked.decision, provenance, { expectedPreviousHash: checked.expectedPreviousHash, signal: publishOptions.signal, maxManagedSkills: options.maxManagedSkills });
            await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft published.", skillId: saved.id, path: saved.path, taskId: id }, { stage: "committed", ...saved, updatedAt: Date.now() }, checked.provenance.fingerprint);
            checked.status = "published";
            checked.published = saved;
            await this.atomic(this.file(id), checked);
            return { ...saved, jobId: id };
        });
    }
    async discard(id) {
        return this.withLock(id, async () => {
            const record = await this.read(id);
            if (!record)
                throw new Error(`Draft ${id} does not exist.`);
            if (record.status === "published")
                throw new Error(`Published draft ${id} cannot be discarded.`);
            await this.queueUpdate(id, "skipped", { status: "skipped", reason: "Draft discarded.", skillId: record.decision.skill?.id, taskId: id }, { stage: "committed", updatedAt: Date.now() }, record.provenance.fingerprint);
            record.status = "discarded";
            await this.atomic(this.file(id), record);
            return { id, status: "discarded" };
        });
    }
}
//# sourceMappingURL=drafts.js.map