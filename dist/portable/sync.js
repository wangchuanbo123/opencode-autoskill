import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveStorageLayout } from "../storage-layout.js";
import { assertSafePath, normalizeHost, readSafeFile, sha256, writeSafeFile } from "./install.js";
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
            if (source.skillId === id && source.skillSha256 === hash)
                result.push({ id, path: file, sha256: hash });
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
    const root = path.resolve(input.root), host = normalizeHost(input.host), layout = resolveStorageLayout(root);
    const destinations = { opencode: ".opencode/skills", "claude-code": ".claude/skills", codex: ".agents/skills", gemini: ".gemini/skills", cursor: ".cursor/skills", generic: ".agents/skills" };
    const manifestFile = path.join(root, ".autoskill", "exports", `${host}.json`), oldText = await readSafeFile(manifestFile);
    const previous = oldText ? JSON.parse(oldText) : { schemaVersion: 1, host, skills: {} };
    if (previous.schemaVersion !== 1 || previous.host !== host || !previous.skills || typeof previous.skills !== "object")
        throw new Error("Invalid native export manifest.");
    const skills = await managedSkills(root);
    const next = { ...previous.skills }, writes = [], deletes = [], conflicts = [];
    for (const skill of skills) {
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
            if (path.isAbsolute(record.file) || record.file.split(/[\\/]/).includes("..") || !record.file.startsWith(path.normalize(destinations[host]) + path.sep))
                throw new Error("Export manifest contains an unsafe path.");
            const file = path.join(root, record.file), content = await readSafeFile(file);
            if (content !== undefined && sha256(content) !== record.exportHash) {
                conflicts.push(id);
                continue;
            }
            if (content !== undefined)
                deletes.push({ file, expected: record.exportHash, id });
            delete next[id];
        }
    if (!input.dryRun) {
        for (const write of writes)
            await writeSafeFile(write.file, write.content, write.expected);
        for (const item of deletes) {
            await assertSafePath(item.file);
            if (sha256(await readSafeFile(item.file) ?? "") !== item.expected)
                throw new Error("Export changed during prune.");
            await fs.unlink(item.file);
        }
        await writeSafeFile(manifestFile, JSON.stringify({ schemaVersion: 1, host, skills: next }, null, 2) + "\n", oldText === undefined ? null : sha256(oldText));
    }
    return { status: input.dryRun ? "dry-run" : "synced", host, authoritativeSkills: layout.skillsRoot, exported: writes.map(item => item.id), pruned: deletes.map(item => item.id), conflicts, reload: "Host skill discovery/reload depends on host; restart or refresh if required." };
}
//# sourceMappingURL=sync.js.map