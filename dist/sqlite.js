import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkOperation, operationDelay } from "./operation-context.js";
export function sqliteBusy(error) {
    const item = error;
    return item?.code === "SQLITE_BUSY" || item?.code === "SQLITE_LOCKED" || item?.errcode === 5 || item?.errcode === 6 ||
        typeof item?.message === "string" && /database is (?:locked|busy)/i.test(item.message);
}
/** Reject links before letting SQLite access its database or WAL sidecars. */
export async function assertSqliteFiles(file) {
    for (const name of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
        try {
            const stat = await fs.lstat(name);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error("Unsafe AutoSkill SQLite file.");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
}
/** Uses only the built-in driver verified in Node 24 and OpenCode 2.2.7 / Bun 1.4.4. */
export async function openSqlite(file, prepare) {
    checkOperation();
    await prepare();
    await assertSqliteFiles(file);
    checkOperation();
    try {
        const handle = await fs.open(file, "wx", 0o600);
        await handle.close();
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
    }
    const bun = typeof globalThis.Bun !== "undefined";
    const moduleName = bun ? "bun:sqlite" : "node:sqlite";
    const driver = await import(moduleName);
    checkOperation();
    const native = bun ? new driver.Database(file, { create: true, strict: true }) : new driver.DatabaseSync(file);
    const database = {
        exec: (sql) => native.exec(sql),
        prepare: (sql) => bun ? native.query(sql) : native.prepare(sql),
        close: () => native.close(),
    };
    const deadline = Date.now() + 5_000;
    try {
        while (true) {
            checkOperation();
            await prepare();
            await assertSqliteFiles(file);
            checkOperation();
            try {
                database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
                return database;
            }
            catch (error) {
                if (!sqliteBusy(error) || Date.now() >= deadline)
                    throw error;
                await operationDelay(15);
            }
        }
    }
    catch (error) {
        database.close();
        throw error;
    }
}
export async function beginImmediate(database, waitMs = 5_000) {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (true) {
        checkOperation();
        try {
            database.exec("BEGIN IMMEDIATE");
            return true;
        }
        catch (error) {
            if (!sqliteBusy(error))
                throw error;
            if (Date.now() >= deadline)
                return false;
            await operationDelay(Math.min(15, Math.max(1, deadline - Date.now())));
        }
    }
}
export async function realDirectoryTree(root, directory) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("AutoSkill path escapes its private root.");
    let current = resolvedRoot;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
        checkOperation();
        if (part)
            current = path.join(current, part);
        try {
            await fs.lstat(current);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            try {
                await fs.mkdir(current, { mode: 0o700 });
            }
            catch (created) {
                if (created.code !== "EEXIST")
                    throw created;
            }
        }
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("Unsafe AutoSkill private directory.");
    }
}
//# sourceMappingURL=sqlite.js.map