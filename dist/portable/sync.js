import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveStorageLayout } from "../storage-layout.js";
import { compatibilityReasons, normalizeCompatibility } from "../compatibility.js";
import { acquireFileLock } from "../lock.js";
import { assertSafePath, ensurePortablePrivate, normalizeHost, readPortableConfig, readSafeFile, sha256, writeSafeFile } from "./install.js";
const destinations = { opencode: ".opencode/skills", "claude-code": ".claude/skills", codex: ".agents/skills", gemini: ".gemini/skills", cursor: ".cursor/skills", generic: ".agents/skills" };
const hashPattern = /^[a-f0-9]{64}$/;
const journalMaxBytes = 16_000_000;
const hashOrNull = (value) => value === null || typeof value === "string" && hashPattern.test(value);
function exportPath(host, file) {
    if (typeof file !== "string" || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || !file.startsWith(path.normalize(destinations[host]) + path.sep))
        throw new Error("Export manifest contains an unsafe path.");
}
function exportManifest(value, host) {
    const manifest = value;
    if (!manifest || manifest.schemaVersion !== 1 || manifest.host !== host || !manifest.skills || typeof manifest.skills !== "object" || Array.isArray(manifest.skills))
        throw new Error("Invalid native export manifest.");
    for (const [id, record] of Object.entries(manifest.skills)) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !record || !hashPattern.test(record.sourceHash) || !hashPattern.test(record.exportHash))
            throw new Error("Invalid native export ownership record.");
        exportPath(host, record.file);
    }
    return manifest;
}
const encodeManifest = (value) => JSON.stringify(value, null, 2) + "\n";
/** Reconcile writes whose Markdown commit preceded the ownership manifest.
 * Only hashes are retained in this journal, not task evidence or skill bodies.
 */
async function recoverExports(root, host, manifestFile, journalFile, dryRun) {
    let text = await readSafeFile(manifestFile);
    const journalText = await readSafeFile(journalFile, journalMaxBytes);
    if (journalText === undefined)
        return { text, recovered: false };
    const journal = JSON.parse(journalText);
    if (!journal || journal.schemaVersion !== 1 || journal.host !== host || !hashOrNull(journal.beforeHash) ||
        journal.recoveryHash !== undefined && !hashPattern.test(journal.recoveryHash) || !Array.isArray(journal.writes) || !Array.isArray(journal.deletes))
        throw new Error("Invalid pending native export transaction.");
    const after = exportManifest(journal.after, host);
    for (const write of journal.writes)
        if (!write || typeof write.id !== "string" || !Object.hasOwn(after.skills, write.id) || !hashOrNull(write.beforeHash))
            throw new Error("Invalid pending export write.");
    for (const item of journal.deletes) {
        if (!item || typeof item.id !== "string" || !hashPattern.test(item.beforeHash))
            throw new Error("Invalid pending export deletion.");
        exportPath(host, item.file);
    }
    const currentHash = text === undefined ? null : sha256(text);
    const afterHash = sha256(encodeManifest(after));
    if (currentHash !== afterHash && currentHash !== journal.recoveryHash) {
        if (currentHash !== journal.beforeHash)
            throw new Error("Export ownership manifest changed during recovery; inspect the pending export transaction.");
        const before = exportManifest(text === undefined ? { schemaVersion: 1, host, skills: {} } : JSON.parse(text), host);
        const skills = { ...before.skills };
        for (const write of journal.writes) {
            const record = after.skills[write.id];
            const content = await readSafeFile(path.join(root, record.file));
            const actual = content === undefined ? null : sha256(content);
            // A committed export can have been edited since the interrupted sync.
            // Retain its intended hash so the next plan reports a protected conflict.
            if (actual !== write.beforeHash)
                skills[write.id] = record;
        }
        for (const item of journal.deletes)
            if (await readSafeFile(path.join(root, item.file)) === undefined)
                delete skills[item.id];
        const recoveredText = encodeManifest({ schemaVersion: 1, host, skills });
        if (!dryRun) {
            // Journal the recovery commit hash first, so a crash after the following
            // rename is itself recoverable without confusing it with a manual edit.
            journal.recoveryHash = sha256(recoveredText);
            const recoveryText = JSON.stringify(journal, null, 2) + "\n";
            await writeSafeFile(journalFile, recoveryText, sha256(journalText), journalMaxBytes);
            await writeSafeFile(manifestFile, recoveredText, currentHash);
        }
        text = recoveredText;
    }
    if (!dryRun) {
        await assertSafePath(journalFile);
        await fs.unlink(journalFile);
    }
    return { text, recovered: true };
}
/** A read-only scan avoids SkillStore.list's legacy/recovery mutations in dry-run. */
async function managedSkills(root) {
    const layout = resolveStorageLayout(root), result = [];
    const scan = async (directory, depth) => {
        await assertSafePath(directory);
        let entries;
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
        if (depth > 0 && entries.some(entry => entry.name === "SKILL.md")) {
            const id = path.basename(directory);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
                return;
            const file = path.join(directory, "SKILL.md"), content = await readSafeFile(file, 256_000);
            if (!content)
                return;
            const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
            if (!frontmatter)
                return;
            let data;
            try {
                data = parseYaml(frontmatter[1], { maxAliasCount: 20, uniqueKeys: true });
            }
            catch {
                return;
            }
            if (data?.metadata?.autoskill !== true)
                return;
            if (await readSafeFile(path.join(layout.stateRoot, "provenance", id, "PUBLISH.json")))
                throw new Error(`Pending skill publication must be recovered before sync: ${id}`);
            const sourceText = await readSafeFile(path.join(layout.stateRoot, "provenance", id, "SOURCE.json")) ?? await readSafeFile(path.join(directory, "SOURCE.json"));
            if (!sourceText)
                return;
            const source = JSON.parse(sourceText), hash = sha256(content);
            if (source.skillId === id && source.skillSha256 === hash) {
                let compatibility, compatibilityInvalid = false;
                try {
                    compatibility = normalizeCompatibility(data.metadata["autoskill-compatibility"]);
                }
                catch {
                    compatibilityInvalid = true;
                }
                result.push({ id, path: file, sha256: hash, compatibility, compatibilityInvalid });
            }
            return;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                throw new Error(`Skill sync refuses symbolic links: ${path.join(directory, entry.name)}`);
            if (entry.isDirectory() && !entry.name.startsWith(".") && depth < 32)
                await scan(path.join(directory, entry.name), depth + 1);
        }
    };
    await scan(layout.skillsRoot, 0);
    if (new Set(result.map(skill => skill.id)).size !== result.length)
        throw new Error("Duplicate managed skill IDs prevent native sync.");
    return result;
}
export async function syncNativeSkills(input) {
    if (input.dryRun)
        return syncUnlocked(input);
    // Keep the old wx-lock path occupied by a permanent directory. Older package
    // versions then fail closed instead of racing a newer SQLite-locked writer.
    const directory = path.join(path.resolve(input.root), ".autoskill", "operation-locks", "native-exports.lock");
    await assertSafePath(directory);
    await ensurePortablePrivate(input.root);
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    try {
        await fs.mkdir(directory, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("A legacy native export operation lock requires inspection; stop every old sync process before removing its lock file.");
    await assertSafePath(directory);
    const release = await acquireFileLock(path.join(directory, "owner.lock"), () => assertSafePath(directory));
    if (!release)
        throw new Error("Native skill sync is already running for this project.");
    try {
        return await syncUnlocked(input);
    }
    finally {
        await release();
    }
}
async function syncUnlocked(input) {
    const root = path.resolve(input.root), host = normalizeHost(input.host), layout = resolveStorageLayout(root);
    const manifestFile = path.join(root, ".autoskill", "exports", `${host}.json`), journalFile = path.join(root, ".autoskill", "exports", `${host}.pending.json`);
    const recovery = await recoverExports(root, host, manifestFile, journalFile, input.dryRun === true), oldText = recovery.text;
    const previous = exportManifest(oldText ? JSON.parse(oldText) : { schemaVersion: 1, host, skills: {} }, host);
    const skills = await managedSkills(root);
    const config = await readPortableConfig(root), capabilities = config.adapters[host]?.capabilities ?? [];
    const next = { ...previous.skills }, writes = [], deletes = [], conflicts = [], skipped = [];
    const removeOwnedExport = async (id, record, revoked = false) => {
        exportPath(host, record.file);
        const file = path.join(root, record.file), content = await readSafeFile(file);
        if (content !== undefined && sha256(content) !== record.exportHash) {
            conflicts.push(id);
            return;
        }
        if (content !== undefined)
            deletes.push({ file, expected: record.exportHash, id, revoked });
        delete next[id];
    };
    for (const skill of skills) {
        const reasons = compatibilityReasons(skill, host, capabilities);
        if (reasons.length) {
            skipped.push({ id: skill.id, reasons });
            // Capability changes revoke unchanged owned copies even without --prune;
            // otherwise native discovery would bypass the new compatibility decision.
            if (next[skill.id])
                await removeOwnedExport(skill.id, next[skill.id], true);
            continue;
        }
        const relative = path.join(destinations[host], skill.id, "SKILL.md"), file = path.join(root, relative);
        if (path.resolve(file) === path.resolve(skill.path))
            continue;
        const content = await readSafeFile(skill.path);
        if (content === undefined || sha256(content) !== skill.sha256)
            throw new Error(`Skill changed during sync: ${skill.id}`);
        const existing = await readSafeFile(file), prior = previous.skills[skill.id];
        if (existing !== undefined && (!prior || prior.file !== relative || sha256(existing) !== prior.exportHash)) {
            conflicts.push(skill.id);
            continue;
        }
        const expected = existing === undefined ? null : sha256(existing);
        if (existing !== content)
            writes.push({ file, content, expected, id: skill.id });
        next[skill.id] = { file: relative, sourceHash: skill.sha256, exportHash: sha256(content) };
    }
    if (input.prune)
        for (const [id, record] of Object.entries(previous.skills)) {
            if (skills.some(skill => skill.id === id))
                continue;
            await removeOwnedExport(id, record);
        }
    if (!input.dryRun) {
        await ensurePortablePrivate(root);
        const after = { schemaVersion: 1, host, skills: next };
        const journal = { schemaVersion: 1, host, beforeHash: oldText === undefined ? null : sha256(oldText), after,
            writes: writes.map(({ id, expected }) => ({ id, beforeHash: expected })), deletes: deletes.map(({ id, file, expected }) => ({ id, file: path.relative(root, file), beforeHash: expected })) };
        if (writes.length || deletes.length)
            await writeSafeFile(journalFile, JSON.stringify(journal, null, 2) + "\n", null, journalMaxBytes);
        for (const write of writes)
            await writeSafeFile(write.file, write.content, write.expected);
        for (const item of deletes) {
            await assertSafePath(item.file);
            if (sha256(await readSafeFile(item.file) ?? "") !== item.expected)
                throw new Error("Export changed during prune.");
            await fs.unlink(item.file);
        }
        await writeSafeFile(manifestFile, encodeManifest(after), oldText === undefined ? null : sha256(oldText));
        if (writes.length || deletes.length)
            await fs.unlink(journalFile);
    }
    return { status: input.dryRun ? "dry-run" : "synced", host, recoveredTransaction: !input.dryRun && recovery.recovered, recoveryPending: !!input.dryRun && recovery.recovered, declaredCapabilities: capabilities, authoritativeSkills: layout.skillsRoot, exported: writes.map(item => item.id), pruned: deletes.filter(item => !item.revoked).map(item => item.id), revoked: deletes.filter(item => item.revoked).map(item => item.id), skipped, conflicts, reload: "Host skill discovery/reload depends on host; restart or refresh if required." };
}
//# sourceMappingURL=sync.js.map