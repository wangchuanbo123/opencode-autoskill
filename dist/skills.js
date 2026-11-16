import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { acquireFileLock } from "./lock.js";
import { redact, redactValue } from "./safety.js";
import { PLUGIN_VERSION } from "./version.js";
import { resolveStorageLayout } from "./storage-layout.js";
const MAX_CONTENT_CHARS = 64_000;
const MAX_FILE_BYTES = 256_000;
const MAX_BACKUPS = 10;
export class SkillConflictError extends Error {
    code = "AUTOSKILL_SKILL_CONFLICT";
}
function assertId(id) {
    if (typeof id !== "string" || id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) {
        throw new Error("Skill id must be a portable lowercase kebab-case name of 1–64 characters.");
    }
}
function hash(content) { return createHash("sha256").update(content).digest("hex"); }
function newVersion() { return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`; }
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function statOrUndefined(file) {
    try {
        return await fs.lstat(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function frontmatter(content) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match)
        return { data: {}, body: content };
    try {
        const value = parseYaml(match[1], { maxAliasCount: 20, uniqueKeys: true });
        if (!value || typeof value !== "object" || Array.isArray(value))
            return { data: {}, body: content };
        return { data: value, body: content.slice(match[0].length) };
    }
    catch {
        return { data: {}, body: content };
    }
}
function metadata(content) {
    const { data, body } = frontmatter(content);
    const meta = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
    return { name: typeof data.name === "string" ? data.name : undefined,
        title: typeof meta["autoskill-title"] === "string" ? meta["autoskill-title"] : /^#\s+(.+)$/m.exec(body)?.[1],
        description: typeof data.description === "string" ? data.description : undefined, marked: meta.autoskill === true,
        version: typeof meta["autoskill-revision"] === "string" ? meta["autoskill-revision"] : undefined };
}
function textArray(values, label, required) {
    if (!Array.isArray(values) || required && values.length === 0 || values.length > 100)
        throw new Error(`Invalid skill ${label}.`);
    return values.map((value) => {
        if (typeof value !== "string" || !value.trim() || value.length > 10_000 || value.includes("\0"))
            throw new Error(`Invalid skill ${label} entry.`);
        return value.trim().replace(/\r\n/g, "\n");
    });
}
function renderSkill(skill, version) {
    assertId(skill.id);
    if (typeof skill.name !== "string" || !skill.name.trim() || skill.name.length > 200 || skill.name.includes("\0"))
        throw new Error("Invalid skill name.");
    if (typeof skill.description !== "string" || !skill.description.trim() || skill.description.length > 2_000 || skill.description.includes("\0"))
        throw new Error("Invalid skill description.");
    const title = skill.name.trim().replace(/[\r\n]+/g, " ");
    const output = ["---", `name: ${JSON.stringify(skill.id)}`, `description: ${JSON.stringify(skill.description.trim())}`, "metadata:", "  autoskill: true", "  autoskill-version: 2", `  autoskill-title: ${JSON.stringify(title)}`, `  autoskill-revision: ${JSON.stringify(version)}`, "---", "", `# ${title}`];
    const sections = [
        ["When to use", textArray(skill.whenToUse, "whenToUse", true), false], ["Prerequisites", textArray(skill.prerequisites, "prerequisites", false), false],
        ["Procedure", textArray(skill.steps, "steps", true), true], ["Pitfalls", textArray(skill.pitfalls, "pitfalls", false), false], ["Verification", textArray(skill.verification, "verification", true), false]
    ];
    for (const [heading, items, numbered] of sections) {
        output.push("", `## ${heading}`, "");
        if (!items.length)
            output.push("None recorded.");
        items.forEach((item, index) => { const prefix = numbered ? `${index + 1}. ` : "- "; output.push(prefix + item.replace(/\n/g, `\n${" ".repeat(prefix.length)}`)); });
    }
    const rendered = output.join("\n") + "\n";
    if (Buffer.byteLength(rendered) > MAX_FILE_BYTES)
        throw new Error("Skill exceeds the maximum file size.");
    return rendered;
}
/** Markdown is shareable; source evidence, usage controls and versions are private. */
export class SkillStore {
    root;
    skillsRoot;
    stateRoot;
    constructor(root) {
        const layout = resolveStorageLayout(root);
        this.root = layout.root;
        this.skillsRoot = layout.skillsRoot;
        this.stateRoot = layout.stateRoot;
    }
    async directory(target, create) {
        if (!inside(this.root, target))
            throw new Error("Skill storage path escapes the project root.");
        const rootStat = await fs.lstat(this.root);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
            throw new Error("Project root must be a real directory.");
        let current = this.root;
        for (const part of path.relative(this.root, target).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            let stat = await statOrUndefined(current);
            if (!stat) {
                if (!create)
                    return false;
                try {
                    await fs.mkdir(current, { mode: 0o700 });
                }
                catch (error) {
                    if (error.code !== "EEXIST")
                        throw error;
                }
                stat = await fs.lstat(current);
            }
            if (stat.isSymbolicLink() || !stat.isDirectory())
                throw new Error("Symbolic links and non-directory storage paths are not allowed.");
        }
        return true;
    }
    async regularFile(file) {
        if (!await this.directory(path.dirname(file), false))
            return false;
        const stat = await statOrUndefined(file);
        if (!stat)
            return false;
        if (stat.isSymbolicLink() || !stat.isFile())
            throw new Error("Symbolic links and non-regular skill files are not allowed.");
        if (stat.size > MAX_FILE_BYTES)
            throw new Error("Existing skill file exceeds the maximum size.");
        return true;
    }
    async privateDirectory() {
        await this.directory(this.stateRoot, true);
        const ignore = path.join(this.stateRoot, ".gitignore");
        if (!await this.regularFile(ignore))
            await fs.writeFile(ignore, "*\n!.gitignore\n", { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST")
                throw error; });
        else if (!/^\s*\*\s*$/m.test(await fs.readFile(ignore, "utf8")))
            await fs.appendFile(ignore, "\n*\n!.gitignore\n", { mode: 0o600 });
    }
    sourcePath(id) { return path.join(this.stateRoot, "provenance", id, "SOURCE.json"); }
    controlPath(id) { return path.join(this.stateRoot, "provenance", id, "CONTROL.json"); }
    pendingPath(id) { return path.join(this.stateRoot, "provenance", id, "PUBLISH.json"); }
    async json(file) {
        if (!await this.regularFile(file))
            return undefined;
        try {
            return JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch {
            return undefined;
        }
    }
    async source(id, skillPath) {
        const value = await this.json(this.sourcePath(id)) ?? await this.json(path.join(path.dirname(skillPath), "SOURCE.json"));
        return value && value.skillId === id && typeof value.skillSha256 === "string" && /^[a-f0-9]{64}$/.test(value.skillSha256) ? value : undefined;
    }
    async control(id) {
        const value = await this.json(this.controlPath(id));
        return { pinned: value?.pinned === true, usageCount: Number.isSafeInteger(value?.usageCount) && value.usageCount >= 0 ? value.usageCount : 0,
            lastUsedAt: typeof value?.lastUsedAt === "string" ? value.lastUsedAt : undefined,
            feedback: { success: Number.isSafeInteger(value?.feedback?.success) && value.feedback.success >= 0 ? value.feedback.success : 0, failure: Number.isSafeInteger(value?.feedback?.failure) && value.feedback.failure >= 0 ? value.feedback.failure : 0 },
            feedbackNotes: Array.isArray(value?.feedbackNotes) ? value.feedbackNotes.slice(-20) : [],
            feedbackSha256: typeof value?.feedbackSha256 === "string" ? value.feedbackSha256 : undefined,
            versionFeedback: { success: Number.isSafeInteger(value?.versionFeedback?.success) && value.versionFeedback.success >= 0 ? value.versionFeedback.success : 0,
                failure: Number.isSafeInteger(value?.versionFeedback?.failure) && value.versionFeedback.failure >= 0 ? value.versionFeedback.failure : 0 } };
    }
    async recover(id, file) {
        const pending = await this.json(this.pendingPath(id));
        if (!pending || !await this.regularFile(file))
            return;
        const current = hash(await fs.readFile(file, "utf8"));
        if (current === pending.nextHash && pending.source?.skillSha256 === current && pending.source.skillId === id) {
            await this.atomicFile(this.sourcePath(id), JSON.stringify(pending.source, null, 2) + "\n");
            await fs.unlink(this.pendingPath(id));
        }
        else if (current === pending.previousHash)
            await fs.unlink(this.pendingPath(id));
    }
    async migrateLegacy(id, file) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
            return;
        const legacy = path.join(path.dirname(file), "SOURCE.json");
        if (!await this.regularFile(legacy))
            return;
        const release = await this.lock(id);
        try {
            const body = await fs.readFile(file, "utf8"), old = await this.json(legacy);
            if (!metadata(body).marked || old?.skillId !== id || old.skillSha256 !== hash(body))
                return;
            const existing = await this.json(this.sourcePath(id));
            if (existing && existing.skillSha256 !== old.skillSha256)
                return;
            if (!existing) {
                const source = { ...redactValue(old, this.root), schemaVersion: 2, pluginVersion: PLUGIN_VERSION,
                    version: old.version ?? metadata(body).version ?? `legacy-${old.skillSha256.slice(0, 16)}` };
                await this.atomicFile(this.sourcePath(id), JSON.stringify(source, null, 2) + "\n");
            }
            await fs.unlink(legacy);
        }
        finally {
            await release();
        }
    }
    async entry(file, archived) {
        const id = path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
        const body = await fs.readFile(file, "utf8"), meta = metadata(body), source = await this.source(id, file), control = await this.control(id), sha256 = hash(body);
        const ownership = !meta.marked ? "unmanaged" : source?.skillSha256 === sha256 ? "managed" : "user-modified", title = meta.title ?? meta.name ?? id;
        return { id, name: title, title, description: meta.description ?? "", path: file, content: body.slice(0, MAX_CONTENT_CHARS), contentComplete: body.length <= MAX_CONTENT_CHARS,
            managed: ownership === "managed" && !archived && !control.pinned, ownership, sha256, generatedHash: source?.skillSha256, pinned: control.pinned === true,
            archived, version: source?.version ?? meta.version, updatedAt: source?.createdAt, usageCount: control.usageCount ?? 0, lastUsedAt: control.lastUsedAt,
            feedback: control.feedback ?? { success: 0, failure: 0 }, versionFeedback: control.feedbackSha256 === sha256 ? control.versionFeedback : { success: 0, failure: 0 } };
    }
    async list() {
        const result = [];
        for (const root of [{ directory: this.skillsRoot, archived: false }, { directory: path.join(this.stateRoot, "archives"), archived: true }]) {
            if (!await this.directory(root.directory, false))
                continue;
            const queue = [{ directory: root.directory, depth: 0 }];
            while (queue.length) {
                const current = queue.shift();
                if (!await this.directory(current.directory, false))
                    continue;
                const entries = (await fs.readdir(current.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
                if (current.depth > 0 && entries.some((entry) => entry.name === "SKILL.md")) {
                    const file = path.join(current.directory, "SKILL.md"), entry = entries.find((item) => item.name === "SKILL.md");
                    if (!entry.isFile() || entry.isSymbolicLink() || (await fs.lstat(file)).size > MAX_FILE_BYTES || !await this.regularFile(file))
                        continue;
                    const id = path.basename(current.directory);
                    if (await this.regularFile(this.pendingPath(id))) {
                        const release = await this.lock(id);
                        try {
                            await this.recover(id, file);
                        }
                        finally {
                            await release();
                        }
                    }
                    await this.migrateLegacy(id, file);
                    result.push(await this.entry(file, root.archived));
                    continue;
                }
                for (const entry of entries) {
                    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink())
                        continue;
                    const file = path.join(current.directory, entry.name);
                    if (entry.isDirectory() && current.depth < 32)
                        queue.push({ directory: file, depth: current.depth + 1 });
                    else if (current.depth === 0 && entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md" && (await fs.lstat(file)).size <= MAX_FILE_BYTES && await this.regularFile(file))
                        result.push(await this.entry(file, root.archived));
                }
            }
        }
        return result;
    }
    async find(id) {
        assertId(id);
        const found = (await this.list()).filter((item) => item.id === id);
        if (!found.length)
            throw new Error(`Skill ${id} does not exist.`);
        if (found.length > 1)
            throw new SkillConflictError(`Skill ${id} has ambiguous duplicate paths.`);
        return found[0];
    }
    async lock(id) {
        await this.privateDirectory();
        const directory = path.join(this.stateRoot, "locks");
        await this.directory(directory, true);
        const release = await acquireFileLock(path.join(directory, `${id}.lock`), () => this.directory(directory, false), 5_000);
        if (!release)
            throw new SkillConflictError(`Skill ${id} is locked by another writer.`);
        return release;
    }
    async atomicFile(file, content, signal, expectedHash, expectedAbsent = false, beforeCommit) {
        signal?.throwIfAborted();
        await this.directory(path.dirname(file), true);
        await this.regularFile(file);
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fs.open(temporary, "wx", 0o600);
            await handle.writeFile(content, "utf8");
            await handle.sync();
            await handle.close();
            handle = undefined;
            await beforeCommit?.();
            await this.directory(path.dirname(file), false);
            const exists = await this.regularFile(file);
            if (expectedAbsent && exists)
                throw new SkillConflictError("Skill was created during review; keeping the existing file.");
            if (expectedHash !== undefined && (!exists || hash(await fs.readFile(file, "utf8")) !== expectedHash))
                throw new SkillConflictError("Skill changed before commit; keeping the current file.");
            signal?.throwIfAborted();
            if (expectedAbsent) {
                // Atomic no-replace installation also protects a file created after the hash check.
                try {
                    await fs.link(temporary, file);
                }
                catch (error) {
                    if (error.code === "EEXIST")
                        throw new SkillConflictError("Skill was created during review; keeping the existing file.");
                    throw error;
                }
            }
            else
                await fs.rename(temporary, file);
        }
        finally {
            await handle?.close();
            if (await statOrUndefined(temporary)) {
                await this.directory(path.dirname(temporary), false);
                await fs.unlink(temporary);
            }
        }
    }
    async backup(id, content, source) {
        const directory = path.join(this.stateRoot, "backups", id), version = source?.version && /^\d{4}-\d\d-\d\dT[a-zA-Z0-9_.-]+$/.test(source.version) ? source.version : newVersion();
        await this.directory(directory, true);
        const file = path.join(directory, `${version}.SKILL.md`);
        if (!await this.regularFile(file))
            await this.atomicFile(file, content);
        if (source)
            await this.atomicFile(path.join(directory, `${version}.SOURCE.json`), JSON.stringify(source, null, 2) + "\n");
        const old = (await fs.readdir(directory)).filter((name) => name.endsWith(".SKILL.md")).sort().reverse().slice(MAX_BACKUPS);
        for (const name of old)
            for (const suffix of ["SKILL.md", "SOURCE.json"]) {
                const target = path.join(directory, name.replace(/SKILL\.md$/, suffix));
                if (await this.regularFile(target))
                    await fs.unlink(target);
            }
    }
    async publish(id, file, content, source, previousHash, signal, beforeCommit) {
        signal?.throwIfAborted();
        const pending = { previousHash, nextHash: hash(content), source };
        await this.atomicFile(this.pendingPath(id), JSON.stringify(pending, null, 2) + "\n", signal);
        try {
            await this.atomicFile(file, content, signal, previousHash, previousHash === undefined, beforeCommit);
        }
        catch (error) {
            if (await this.regularFile(this.pendingPath(id)))
                await fs.unlink(this.pendingPath(id));
            throw error;
        }
        // Installing the Markdown is the commit point; finish private metadata afterward.
        await this.atomicFile(this.sourcePath(id), JSON.stringify(source, null, 2) + "\n");
        if (await this.regularFile(this.pendingPath(id)))
            await fs.unlink(this.pendingPath(id));
        const legacy = path.join(path.dirname(file), "SOURCE.json");
        if (await this.regularFile(legacy))
            await fs.unlink(legacy);
    }
    async save(decision, provenance, options = {}) {
        if (decision.action === "skip" || !decision.skill)
            throw new Error("Cannot save a skipped or missing skill.");
        const skill = decision.skill;
        assertId(skill.id);
        options.signal?.throwIfAborted();
        renderSkill(skill, "validation");
        const indexed = (await this.list()).filter((item) => item.id === skill.id);
        if (indexed.length > 1)
            throw new SkillConflictError("Skill id has ambiguous duplicate paths.");
        if (indexed[0]?.archived)
            throw new SkillConflictError("Skill is archived; restore it explicitly before updating.");
        const file = indexed[0]?.path ?? path.join(this.skillsRoot, skill.id, "SKILL.md"), release = await this.lock(skill.id);
        let releaseQuota;
        try {
            await this.recover(skill.id, file);
            const exists = await this.regularFile(file), previous = exists ? await fs.readFile(file, "utf8") : undefined;
            const source = await this.source(skill.id, file), control = await this.control(skill.id), previousHash = previous === undefined ? undefined : hash(previous);
            if (previous !== undefined && !metadata(previous).marked)
                throw new SkillConflictError("Refusing to overwrite a user-owned skill.");
            if (previous !== undefined && (!source || source.skillSha256 !== previousHash))
                throw new SkillConflictError("Skill has manual changes or untrusted provenance; adopt it explicitly before updating.");
            if (control.pinned)
                throw new SkillConflictError("Skill is pinned and cannot be automatically updated.");
            if (previous !== undefined && renderSkill(skill, source?.version ?? metadata(previous).version ?? "legacy") === previous)
                return { path: file, id: skill.id, changed: false, sha256: previousHash, version: source.version };
            if (exists && decision.action === "create")
                throw new SkillConflictError("Skill already exists; use an update decision.");
            if (!exists && decision.action === "update")
                throw new Error("Cannot update a skill that does not exist.");
            if (exists && (!options.expectedPreviousHash || options.expectedPreviousHash !== previousHash))
                throw new SkillConflictError("Skill changed since review or expectedPreviousHash is missing.");
            if (!exists && options.maxManagedSkills !== undefined) {
                if (!Number.isSafeInteger(options.maxManagedSkills) || options.maxManagedSkills < 1)
                    throw new Error("Managed skill quota must be a positive integer.");
                releaseQuota = await this.lock("__quota");
                if ((await this.list()).filter((item) => !item.archived && item.ownership === "managed").length >= options.maxManagedSkills)
                    throw new Error("Managed skill quota reached; archive unused skills before creating another.");
            }
            options.signal?.throwIfAborted();
            if (previous !== undefined)
                await this.backup(skill.id, previous, source);
            const version = newVersion(), content = renderSkill(skill, version), safe = redactValue(provenance, this.root);
            const nextSource = { schemaVersion: 2, pluginVersion: PLUGIN_VERSION, skillId: skill.id, skillSha256: hash(content), version, sessionId: safe.sessionId,
                fingerprint: safe.fingerprint, messageIds: safe.messageIds,
                evidence: safe.evidence.map((citation) => ({ toolCallId: citation.toolCallId, excerpt: citation.excerpt, supports: citation.supports })),
                createdAt: safe.createdAt, model: safe.model, templateHash: safe.templateHash, taskId: safe.taskId, decisionReason: safe.decisionReason, assessment: safe.assessment,
                hostId: safe.hostId, workspaceId: safe.workspaceId, turnId: safe.turnId, revision: safe.revision };
            if (Buffer.byteLength(JSON.stringify(nextSource)) > MAX_FILE_BYTES)
                throw new Error("Skill provenance exceeds the maximum size.");
            await this.publish(skill.id, file, content, nextSource, previousHash, options.signal, options.beforeCommit);
            return { path: file, id: skill.id, changed: true, sha256: nextSource.skillSha256, version };
        }
        finally {
            try {
                await releaseQuota?.();
            }
            finally {
                await release();
            }
        }
    }
    async inspect(id) {
        const skill = await this.find(id), directory = path.join(this.stateRoot, "backups", id);
        const versions = await this.directory(directory, false) ? (await fs.readdir(directory)).filter((name) => name.endsWith(".SKILL.md")).map((name) => name.slice(0, -9)).sort().reverse() : [];
        return { skill, versions, provenance: await this.source(id, skill.path) };
    }
    async updateControl(id, update, expectedHash) {
        const current = await this.find(id);
        const release = await this.lock(id);
        try {
            if (expectedHash !== undefined && (!await this.regularFile(current.path) || hash(await fs.readFile(current.path, "utf8")) !== expectedHash))
                throw new SkillConflictError("Skill changed before feedback was recorded.");
            const control = await this.control(id);
            update(control);
            await this.atomicFile(this.controlPath(id), JSON.stringify(control, null, 2) + "\n");
        }
        finally {
            await release();
        }
        return this.find(id);
    }
    async pin(id, pinned = true) { return this.updateControl(id, (control) => { control.pinned = pinned; }); }
    async recordUsage(id) { return this.updateControl(id, (control) => { control.usageCount = (control.usageCount ?? 0) + 1; control.lastUsedAt = new Date().toISOString(); }); }
    async feedback(id, input) {
        if (!["success", "failure"].includes(input.outcome))
            throw new Error("Feedback outcome must be success or failure.");
        const current = await this.find(id);
        return this.updateControl(id, (control) => {
            control.feedback ??= { success: 0, failure: 0 };
            control.feedback[input.outcome]++;
            control.feedbackNotes = [...(control.feedbackNotes ?? []), { at: new Date().toISOString(), outcome: input.outcome, notes: input.notes ? redact(input.notes, this.root).slice(0, 1_000) : undefined }].slice(-20);
            if (control.feedbackSha256 !== current.sha256) {
                control.feedbackSha256 = current.sha256;
                control.versionFeedback = { success: 0, failure: 0 };
            }
            control.versionFeedback ??= { success: 0, failure: 0 };
            control.versionFeedback[input.outcome]++;
        }, current.sha256);
    }
    async archive(id, options = {}) {
        options.signal?.throwIfAborted();
        const skill = await this.find(id);
        if (skill.archived)
            return skill;
        if (skill.pinned || skill.ownership !== "managed")
            throw new SkillConflictError("Only unpinned, unchanged generated skills can be archived.");
        const release = await this.lock(id);
        try {
            // Another lifecycle action may have completed while this action waited for its lock.
            if (!await this.regularFile(skill.path))
                throw new SkillConflictError("Skill moved before archive; inspect its current location.");
            const body = await fs.readFile(skill.path, "utf8"), source = await this.source(id, skill.path), control = await this.control(id);
            if (control.pinned)
                throw new SkillConflictError("Skill was pinned before archive.");
            if (!metadata(body).marked || !source || hash(body) !== source.skillSha256 || hash(body) !== skill.sha256)
                throw new SkillConflictError("Skill changed before archive.");
            if (options.expectedHash !== undefined && hash(body) !== options.expectedHash)
                throw new SkillConflictError("Skill changed since the governance plan was prepared.");
            options.signal?.throwIfAborted();
            const target = path.join(this.stateRoot, "archives", id);
            await this.directory(path.dirname(target), true);
            if (await statOrUndefined(target))
                throw new SkillConflictError("Archived skill already exists.");
            await this.directory(path.dirname(skill.path), false);
            options.signal?.throwIfAborted();
            if (path.basename(skill.path) === "SKILL.md")
                await fs.rename(path.dirname(skill.path), target);
            else {
                await this.directory(target, true);
                await fs.rename(skill.path, path.join(target, "SKILL.md"));
            }
        }
        finally {
            await release();
        }
        return this.find(id);
    }
    async restore(id, version) {
        const current = await this.find(id);
        if (current.ownership !== "managed")
            throw new SkillConflictError("Current skill has manual changes or is not managed; refusing rollback.");
        const release = await this.lock(id);
        try {
            if (!await this.regularFile(current.path))
                throw new SkillConflictError("Skill moved before rollback; inspect its current location.");
            const currentBody = await fs.readFile(current.path, "utf8"), currentSource = await this.source(id, current.path);
            if (!metadata(currentBody).marked || hash(currentBody) !== current.sha256 || currentSource?.skillSha256 !== current.sha256)
                throw new SkillConflictError("Skill changed before rollback.");
            if (current.archived && version === undefined) {
                const target = path.join(this.skillsRoot, id);
                await this.directory(this.skillsRoot, true);
                if (await statOrUndefined(target))
                    throw new SkillConflictError("An active skill already occupies this id.");
                await fs.rename(path.dirname(current.path), target);
            }
            else {
                const directory = path.join(this.stateRoot, "backups", id);
                if (!await this.directory(directory, false))
                    throw new Error("No skill versions are available.");
                const selected = version ?? (await fs.readdir(directory)).filter((name) => name.endsWith(".SKILL.md")).sort().reverse()[0]?.slice(0, -9);
                if (!selected || !/^[a-zA-Z0-9_.-]+$/.test(selected))
                    throw new Error("Invalid or missing rollback version.");
                const file = path.join(directory, `${selected}.SKILL.md`);
                if (!await this.regularFile(file))
                    throw new Error("Rollback version does not exist.");
                const body = await fs.readFile(file, "utf8"), source = await this.json(path.join(directory, `${selected}.SOURCE.json`));
                if (!source || source.skillSha256 !== hash(body) || source.skillId !== id)
                    throw new SkillConflictError("Rollback version has untrusted provenance.");
                await this.backup(id, await fs.readFile(current.path, "utf8"), await this.source(id, current.path));
                await this.publish(id, current.path, body, source, current.sha256);
            }
        }
        finally {
            await release();
        }
        return this.find(id);
    }
    /** Explicit user action accepts current Markdown as the new automation baseline. */
    async adopt(id) {
        const current = await this.find(id), release = await this.lock(id);
        try {
            if (!await this.regularFile(current.path))
                throw new SkillConflictError("Skill moved before adoption; inspect its current location.");
            const previous = await fs.readFile(current.path, "utf8");
            if (hash(previous) !== current.sha256)
                throw new SkillConflictError("Skill changed before adoption.");
            await this.backup(id, previous, await this.source(id, current.path));
            const parsed = frontmatter(previous), version = newVersion(), meta = parsed.data.metadata && typeof parsed.data.metadata === "object" && !Array.isArray(parsed.data.metadata) ? parsed.data.metadata : {};
            const data = { ...parsed.data, name: id, metadata: { ...meta, autoskill: true, "autoskill-version": 2, "autoskill-title": current.title, "autoskill-revision": version } };
            const body = `---\n${stringifyYaml(data).trimEnd()}\n---\n${parsed.body}`;
            const source = { schemaVersion: 2, pluginVersion: PLUGIN_VERSION, skillId: id, skillSha256: hash(body), version, sessionId: "manual-adoption", fingerprint: hash(previous), messageIds: [], evidence: [], createdAt: new Date().toISOString() };
            await this.publish(id, current.path, body, source, current.sha256);
        }
        finally {
            await release();
        }
        return this.find(id);
    }
}
//# sourceMappingURL=skills.js.map