import type { ReviewResult } from "./types.js";
export interface SessionState {
    cursor?: string;
    lastReview?: number;
}
export interface RuntimeState {
    version: 1 | 2;
    day: string;
    reviews: number;
    sessions: Record<string, SessionState>;
    attempts: Record<string, number>;
    recent: {
        at: string;
        sessionId: string;
        result: ReviewResult;
        reasonCode?: string;
        jobId?: string;
    }[];
}
export declare function emptyState(): RuntimeState;
export declare function ensurePrivateDirectory(root: string): Promise<string>;
export declare function ensurePrivateIgnore(directory: string): Promise<void>;
export declare function regularStateFile(file: string, limit?: number): Promise<boolean>;
export declare function validateRuntimeState(raw: unknown): RuntimeState;
export declare function atomicStateJson(file: string, value: unknown): Promise<void>;
/** v0.1-compatible JSON diagnostics; QueueStore is the v0.2 transactional authority. */
export declare class StateStore {
    readonly root: string;
    readonly directory: string;
    constructor(root: string);
    load(): Promise<RuntimeState>;
    save(state: RuntimeState): Promise<void>;
    record(sessionId: string, result: ReviewResult, reasonCode?: string, jobId?: string): Promise<void>;
    lock(): Promise<(() => Promise<void>) | undefined>;
}
