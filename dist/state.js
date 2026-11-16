import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFileLock } from "./lock.js";
import { realDirectoryTree } from "./sqlite.js";
import { resolveStorageLayout } from "./storage-layout.js";
export function emptyState() {
    return { version: 1, day: new Date().toISOString().slice(0, 10), reviews: 0, sessions: {}, attempts: {}, recent: [] };
}
export async function ensurePrivateDirectory(root) {
    const directory = resolveStorageLayout(root).stateRoot;
    await realDirectoryTree(path.resolve(root), directory);
    await ensurePrivateIgnore(directory);
    return directory;
}
export async function ensurePrivateIgnore(directory) {
    const file = path.join(directory, ".gitignore");
    try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
            await handle.writeFile("# AutoSkill private execution data\n*\n!.gitignore\n");
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000)
            throw new Error("Unsafe AutoSkill ignore file.");
        const text = await fs.readFile(file, "utf8");
        if (!/^\*\s*$/m.test(text))
            await fs.appendFile(file, "\n# AutoSkill private execution data\n*\n!.gitignore\n");
    }
}
export async function regularStateFile(file, limit = 32_000_000) {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
            throw new Error("Unsafe or oversized AutoSkill state file.");
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
export function validateRuntimeState(raw) {
    const value = raw;
    if (!value || ![1, 2].includes(value.version) || typeof value.day !== "string" || !Number.isInteger(value.reviews) || value.reviews < 0 ||
        !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions) ||
        !value.attempts || typeof value.attempts !== "object" || Array.isArray(value.attempts) || !Array.isArray(value.recent)) {
        throw new Error("Invalid AutoSkill state; preserve it and inspect before resetting.");
    }
    value.sessions = Object.fromEntries(Object.entries(value.sessions).filter(([, item]) => item && typeof item === "object" &&
        (item.cursor === undefined || typeof item.cursor === "string") && (item.lastReview === undefined || Number.isFinite(item.lastReview))));
    value.attempts = Object.fromEntries(Object.entries(value.attempts).filter(([, count]) => Number.isInteger(count) && count >= 0));
    if (value.day !== new Date().toISOString().slice(0, 10)) {
        value.day = new Date().toISOString().slice(0, 10);
        value.reviews = 0;
    }
    return value;
}
export async function atomicStateJson(file, value) {
    await regularStateFile(file);
    const temp = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
    try {
        const handle = await fs.open(temp, "wx", 0o600);
        try {
            await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await regularStateFile(file);
        await fs.rename(temp, file);
    }
    finally {
        await fs.unlink(temp).catch(() => undefined);
    }
}
/** v0.1-compatible JSON diagnostics; QueueStore is the v0.2 transactional authority. */
export class StateStore {
    root;
    directory;
    constructor(root) {
        this.root = root;
        this.directory = resolveStorageLayout(root).stateRoot;
    }
    async load() {
        await ensurePrivateDirectory(this.root);
        const file = path.join(this.directory, "state.json");
        if (!await regularStateFile(file))
            return emptyState();
        return validateRuntimeState(JSON.parse(await fs.readFile(file, "utf8")));
    }
    async save(state) {
        await ensurePrivateDirectory(this.root);
        state.sessions = Object.fromEntries(Object.entries(state.sessions).slice(-1_000));
        state.attempts = Object.fromEntries(Object.entries(state.attempts).slice(-5_000));
        state.recent = state.recent.slice(-200);
        await atomicStateJson(path.join(this.directory, "state.json"), state);
    }
    async record(sessionId, result, reasonCode, jobId) {
        await ensurePrivateDirectory(this.root);
        const file = path.join(this.directory, "events.jsonl");
        if (await regularStateFile(file)) {
            if ((await fs.stat(file)).size > 1_000_000) {
                const old = path.join(this.directory, "events.previous.jsonl");
                await regularStateFile(old);
                await fs.rename(file, old);
            }
        }
        await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), sessionId, ...result, reasonCode, jobId }) + "\n", { mode: 0o600 });
    }
    async lock() {
        await ensurePrivateDirectory(this.root);
        return acquireFileLock(path.join(this.directory, "review.lock"), () => ensurePrivateDirectory(this.root));
    }
}
//# sourceMappingURL=state.js.map