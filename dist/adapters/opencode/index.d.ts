import type { Plugin } from "@opencode/plugin";
import { AutoSkillEngine } from "../../engine.js";
import type { EnginePort, HostCapabilities, TaskSnapshot } from "../../types.js";
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
type SessionRecords = Awaited<ReturnType<Plugin.Context["session"]["context"]>>;
export type AdapterEngine = Pick<AutoSkillEngine, "schedule" | "review" | "status" | "dispose"> & {
    prepareReuse?(input: {
        sessionId: string;
        messageId: string;
        text: string;
        signal?: AbortSignal;
    }): Promise<void>;
    reuseContext?(sessionId: string, signal?: AbortSignal, messageId?: string, queryHash?: string): Promise<{
        text: string;
        candidateIds: string[];
        catalog?: {
            id: string;
            description: string;
            hostIds?: string[];
        }[];
    } | undefined>;
    loadReuse?(input: {
        sessionId: string;
        skillId: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    searchReuse?(input: {
        sessionId: string;
        query: string;
        signal?: AbortSignal;
    }): Promise<unknown>;
    reuseFeedback?(input: {
        sessionId: string;
        skillId: string;
        outcome: "success" | "failure" | "unknown";
        used?: boolean;
        signal?: AbortSignal;
    }): Promise<unknown>;
};
export type EngineFactory = (port: EnginePort) => AdapterEngine;
/** Guard the experimental API contract before starting background work. */
export declare function detectCapabilities(ctx: Plugin.Context): HostCapabilities;
/** Reuse has an independent admission/context API contract; distillation can remain available. */
export declare function detectReuseCapabilities(ctx: Plugin.Context): HostCapabilities;
/** Only remove recognized, exact-ID managed entries; preserve all external skills and unknown formats. */
export declare function filterManagedSkillCatalog(text: string, managedIds: ReadonlySet<string>): string;
/** Convert the public V2 transcript, excluding reasoning, native metadata and attachments. */
export declare function normalizeSnapshot(info: SessionInfo, records: SessionRecords, _terminal: TaskSnapshot["terminal"]): TaskSnapshot;
/** Public setup seam for testing against the same V2 surface used by OpenCode. */
export declare function setupAdapter(ctx: Plugin.Context, createEngine?: EngineFactory): Promise<Plugin.Cleanup>;
declare const _default: {
    id: string;
    setup: typeof setupAdapter;
};
export default _default;
