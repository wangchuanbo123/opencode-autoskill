import { type ReuseRequest, type ReuseContext } from "./reuse.js";
import type { EnginePort, ReviewResult, TaskSnapshot } from "./types.js";
export declare class AutoSkillEngine {
    private readonly port;
    private readonly options;
    private readonly ready;
    private root;
    private store;
    private queue;
    private global;
    private drafts;
    private reuse;
    private active?;
    private timer?;
    private collections;
    private controllers;
    private disposed;
    private manual;
    private lastFailure?;
    constructor(port: EnginePort);
    schedule(sessionId: string, terminal: TaskSnapshot["terminal"]): void;
    /** Persist completed evidence before a short-lived host hook exits. */
    enqueue(sessionId: string, terminal?: TaskSnapshot["terminal"], signal?: AbortSignal): Promise<ReviewResult>;
    private sessionKey;
    private ownsJob;
    private note;
    private reconcile;
    private allowed;
    private inProject;
    private screeningKey;
    private taskAssessments;
    private capture;
    review(sessionId: string, force?: boolean, signal?: AbortSignal, dryRun?: boolean): Promise<ReviewResult>;
    private runReview;
    private wake;
    private drain;
    private start;
    private skills;
    private complete;
    private execute;
    status(): Promise<unknown>;
    prepareReuse(request: ReuseRequest): Promise<void>;
    reuseContext(sessionId: string, signal?: AbortSignal, messageId?: string, queryHash?: string): Promise<ReuseContext | undefined>;
    loadReuse(input: {
        sessionId: string;
        skillId: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    searchReuse(input: {
        sessionId: string;
        query: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    reuseFeedback(input: {
        sessionId: string;
        skillId: string;
        outcome: "success" | "failure" | "unknown";
        used?: boolean;
        signal?: AbortSignal;
    }): Promise<unknown>;
    dispose(): Promise<void>;
}
