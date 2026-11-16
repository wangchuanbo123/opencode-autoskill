import { type RuntimeState } from "./state.js";
import type { TaskSnapshot, ReviewResult, ReviewDecision, HostCapabilities } from "./types.js";
export type JobStatus = "pending" | "running" | "retry" | "saved" | "skipped" | "failed" | "draft" | "cancelled";
export interface JobLease {
    token: string;
    pid: number;
    expiresAt: number;
}
export interface Publication {
    stage: "prepared" | "published" | "committed";
    skillId?: string;
    path?: string;
    sha256?: string;
    updatedAt: number;
}
export interface QueueJob {
    id: string;
    sessionId: string;
    fingerprint: string;
    status: JobStatus;
    snapshot?: TaskSnapshot;
    attempts: number;
    createdAt: number;
    updatedAt: number;
    nextRunAt: number;
    lease?: JobLease;
    result?: ReviewResult;
    reasonCode?: string;
    publication?: Publication;
    estimatedInputTokens?: number;
    taskId?: string;
    anchorId?: string;
    force?: boolean;
    draftDecision?: ReviewDecision;
    lastErrorCode?: string;
    coverage?: string[];
    hostId?: string;
    workspaceId?: string;
    [key: string]: unknown;
}
export interface QueueState extends Omit<RuntimeState, "version"> {
    version: 2;
    jobs: Record<string, QueueJob>;
    lastEventAt?: number;
    lastDecision?: {
        at: number;
        sessionId: string;
        jobId?: string;
        reasonCode: string;
        result: ReviewResult;
    };
    metrics?: Record<string, number>;
    inputTokens?: number;
    inputTokensDay?: string;
    capabilities?: HostCapabilities;
    lastRecoveryAt?: number;
    observedSkillTools?: Record<string, boolean>;
    [key: string]: unknown;
}
/** Durable queue with brief SQLite transactions. Never await model/network work inside transaction(). */
export declare class QueueStore {
    readonly root: string;
    readonly directory: string;
    readonly file: string;
    private opening?;
    private serial;
    private closed;
    private diagnosticError?;
    constructor(root: string);
    private database;
    private state;
    read(): Promise<QueueState>;
    transaction<T>(change: (state: QueueState) => T): Promise<T>;
    upsert(job: QueueJob): Promise<{
        inserted: boolean;
        job: QueueJob;
    }>;
    claim(jobId?: string, leaseMs?: number): Promise<QueueJob | undefined>;
    finish(jobId: string, token: string, result: ReviewResult, status: JobStatus, publication?: Publication): Promise<boolean>;
    recover(): Promise<{
        recovered: number;
        publications: QueueJob[];
    }>;
    record(sessionId: string, result: ReviewResult, reasonCode: string, jobId?: string): Promise<void>;
    close(): Promise<void>;
}
export declare function privateStateHome(): string;
export interface BudgetUsage {
    day: string;
    reviews: number;
    inputTokens: number;
}
export interface BudgetLimits {
    maxReviewsPerDay: number;
    estimatedInputTokens?: number;
    maxInputTokensPerDay?: number;
}
export interface BudgetReservation {
    allowed: boolean;
    reasonCode: string;
    used: BudgetUsage;
    nextRunAt: number;
}
/** A shared private counter across projects; conservative reservation precedes provider calls. */
export declare class GlobalBudgetStore {
    readonly directory: string;
    private opening?;
    private serial;
    private closed;
    constructor(directory?: string);
    private prepare;
    private database;
    private usage;
    read(): Promise<BudgetUsage>;
    reserve(id: string, limits: BudgetLimits): Promise<BudgetReservation>;
    close(): Promise<void>;
}
