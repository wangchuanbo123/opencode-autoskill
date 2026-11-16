import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openSqlite, beginImmediate } from "./sqlite.js";

export class LockInspectionError extends Error {
  readonly code = "AUTOSKILL_LOCK_NEEDS_INSPECTION";
  constructor(readonly file: string, reason: string) {
    super(`AutoSkill legacy lock requires inspection (${reason}); stop every old OpenCode process for this project before removing it.`);
    this.name = "LockInspectionError";
  }
}

/**
 * A short exclusive SQLite transaction is the lock. OS/database locks are released
 * on process exit; no PID check-and-unlink or expiry-based takeover is involved.
 * Persistent .sqlite files are lock databases, not evidence of a running owner.
 */
export async function acquireFileLock(
  file: string,
  prepare: () => Promise<unknown>,
  waitMs = 0,
): Promise<(() => Promise<void>) | undefined> {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    await prepare();
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) throw new Error("Unsafe AutoSkill lock file.");
      let owner: { pid?: number; token?: string };
      let text = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        text = await fs.readFile(file, "utf8");
        try { owner = JSON.parse(text); break; } catch {
          if (attempt === 4) throw new LockInspectionError(file, "invalid owner record");
          await delay(10);
        }
      }
      owner ??= {};
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.token !== "string" || !owner.token) throw new LockInspectionError(file, "unknown owner");
      try { process.kill(owner.pid!, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new LockInspectionError(file, "owner liveness could not be confirmed");
        // The old protocol never reclaims a dead-owner file. Leave this record
        // intact as a tombstone that still blocks old writers; use SQLite for v2.
        // There is deliberately no check-then-unlink or check-then-rename here.
        break;
      }
      if (Date.now() >= deadline) return undefined;
      await delay(Math.min(15, Math.max(1, deadline - Date.now())));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const database = await openSqlite(`${file}.sqlite`, prepare);
  let acquired = false;
  try {
    acquired = await beginImmediate(database, Math.max(0, deadline - Date.now()));
    if (!acquired) { database.close(); return undefined; }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { database.exec("COMMIT"); } finally { database.close(); }
    };
  } catch (error) {
    if (acquired) { try { database.exec("ROLLBACK"); } catch { /* preserve original error */ } }
    database.close();
    throw error;
  }
}
