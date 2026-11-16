import { AutoSkillEngine } from "../engine.js";
import { SkillStore } from "../skills.js";
import { type HostId } from "../adapters/events.js";
import { readPortableConfig } from "./install.js";
import { reviewerStatus } from "./reviewer.js";
import { EventStore, type PortableTask } from "./event-store.js";
export declare class PortableRuntime {
    readonly root: string;
    readonly host: HostId;
    readonly config: Awaited<ReturnType<typeof readPortableConfig>>;
    readonly events: EventStore;
    readonly engine: AutoSkillEngine;
    readonly skills: SkillStore;
    readonly backend: ReturnType<typeof reviewerStatus>;
    private constructor();
    static open(root: string, host: HostId, options?: {
        background?: boolean;
        automaticReuse?: boolean;
    }): Promise<PortableRuntime>;
    private prepare;
    context(task: PortableTask, signal?: AbortSignal): Promise<string>;
    resolveTask(token: unknown): Promise<PortableTask>;
    search(query: string, token?: unknown, signal?: AbortSignal): Promise<unknown>;
    load(skillId: string, token: unknown, signal?: AbortSignal): Promise<unknown>;
    feedback(input: {
        skillId: string;
        contextToken: unknown;
        used: boolean;
        outcome: "success" | "failure" | "unknown";
    }, signal?: AbortSignal): Promise<unknown>;
    capturePending(): Promise<number>;
    review(token: unknown, dryRun?: boolean, signal?: AbortSignal): Promise<unknown>;
    status(): Promise<unknown>;
    close(): Promise<void>;
}
export declare function readStdinJson(maxBytes?: number): Promise<unknown>;
export declare function runRuntimeCommand(input: {
    command: string;
    host: HostId;
    root: string;
    event?: string;
    input?: unknown;
    dryRun?: boolean;
}): Promise<unknown>;
