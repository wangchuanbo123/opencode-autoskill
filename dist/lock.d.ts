export declare class LockInspectionError extends Error {
    readonly file: string;
    readonly code = "AUTOSKILL_LOCK_NEEDS_INSPECTION";
    constructor(file: string, reason: string);
}
/**
 * A short exclusive SQLite transaction is the lock. OS/database locks are released
 * on process exit; no PID check-and-unlink or expiry-based takeover is involved.
 * Persistent .sqlite files are lock databases, not evidence of a running owner.
 */
export declare function acquireFileLock(file: string, prepare: () => Promise<unknown>, waitMs?: number): Promise<(() => Promise<void>) | undefined>;
