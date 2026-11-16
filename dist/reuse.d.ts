import { ReuseStore } from "./reuse-store.js";
import type { AutoSkillOptions, EnginePort, TaskSnapshot } from "./types.js";
export interface ReuseRequest {
    sessionId: string;
    messageId: string;
    text: string;
    signal?: AbortSignal;
}
export interface ReuseContext {
    text: string;
    candidateIds: string[];
    catalog: {
        id: string;
        description: string;
        hostIds?: string[];
    }[];
}
/** Task-specific retrieval and bounded context. Contains no independent model or shell execution. */
export declare class ReuseEngine {
    private root;
    private options;
    private port;
    readonly ledger: ReuseStore;
    private store;
    private prepared;
    private latest;
    private active;
    private registryHash?;
    private lastScreen?;
    constructor(root: string, options: AutoSkillOptions, port: EnginePort);
    private enabled;
    private sessionIdentity;
    private key;
    private remember;
    private policy;
    private skills;
    prepare(request: ReuseRequest): Promise<void>;
    private restore;
    private valid;
    context(sessionId: string, signal?: AbortSignal, messageId?: string, queryHash?: string): Promise<ReuseContext | undefined>;
    load(input: {
        sessionId: string;
        skillId: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    search(input: {
        sessionId: string;
        query: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    feedback(input: {
        sessionId: string;
        skillId: string;
        outcome: "success" | "failure" | "unknown";
        used?: boolean;
        signal?: AbortSignal;
    }): Promise<unknown>;
    finish(snapshot: TaskSnapshot, signal?: AbortSignal): Promise<void>;
    status(): Promise<unknown>;
    close(): Promise<void>;
}
