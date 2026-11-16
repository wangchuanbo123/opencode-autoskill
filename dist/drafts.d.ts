import type { ReviewDecision, ReviewProvenance, ToolRecord } from "./types.js";
export interface DraftRecord {
    id: string;
    decision: ReviewDecision;
    provenance: ReviewProvenance;
    evidence: ToolRecord[];
    expectedPreviousHash?: string;
    options?: Record<string, unknown>;
    createdAt?: string;
}
export interface DraftSummary {
    id: string;
    action: ReviewDecision["action"];
    skillId?: string;
    name?: string;
    reason: string;
    createdAt: string;
    status: "draft" | "published" | "discarded";
}
export interface PublishDraftOptions {
    signal?: AbortSignal;
}
/** Private, reviewable candidates which can be published after explicit user approval. */
export declare class DraftStore {
    readonly root: string;
    readonly directory: string;
    private readonly lockDirectory;
    constructor(root: string);
    private prepare;
    private realDirectory;
    private file;
    private regular;
    private read;
    private atomic;
    private withLock;
    private validate;
    create(input: DraftRecord): Promise<DraftRecord>;
    list(): Promise<DraftSummary[]>;
    inspect(id: string): Promise<DraftRecord>;
    private queueUpdate;
    private priorPublication;
    publish(id: string, publishOptions?: PublishDraftOptions): Promise<{
        path: string;
        id: string;
        changed: boolean;
        sha256: string;
        version: string;
        jobId: string;
    }>;
    discard(id: string): Promise<{
        id: string;
        status: "discarded";
    }>;
}
