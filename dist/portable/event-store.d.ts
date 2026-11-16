import type { AutoSkillOptions, TaskSnapshot } from "../types.js";
import type { HostId, NormalizedHook } from "../adapters/events.js";
export interface PortableTask {
    id: string;
    contextToken: string;
    host: HostId;
    nativeSessionId: string;
    nativeTurnId?: string;
    messageId: string;
    queryHash: string;
    prompt: string;
    sensitive: boolean;
    snapshot: TaskSnapshot;
    ended: boolean;
    captured: boolean;
    trusted: boolean;
    coverage: string[];
    createdAt: number;
    updatedAt: number;
}
/** Hook receipts and task evidence are private, with short cross-process transactions. */
export declare class EventStore {
    readonly root: string;
    private options;
    private opening?;
    private serial;
    readonly file: string;
    readonly workspaceId: string;
    constructor(root: string, options: AutoSkillOptions);
    private database;
    private transaction;
    private decode;
    private save;
    private create;
    accept(event: NormalizedHook): Promise<{
        task?: PortableTask;
        duplicate?: boolean;
        reasonCode?: string;
    }>;
    explicit(host: HostId, prompt: string): Promise<PortableTask>;
    get(id: string): Promise<PortableTask | undefined>;
    token(token: string, host: HostId): Promise<PortableTask | undefined>;
    pending(host?: HostId): Promise<PortableTask[]>;
    captured(id: string): Promise<void>;
    status(): Promise<unknown>;
    close(): Promise<void>;
}
