import type { ExistingSkill, ReviewDecision, ReviewProvenance } from "./types.js";
export interface StoredSkill extends ExistingSkill {
    title: string;
    sha256: string;
    generatedHash?: string;
    ownership: "managed" | "user-modified" | "unmanaged";
    pinned: boolean;
    archived: boolean;
    version?: string;
    usageCount: number;
    lastUsedAt?: string;
    feedback: {
        success: number;
        failure: number;
    };
}
export interface SaveOptions {
    expectedPreviousHash?: string;
    signal?: AbortSignal;
    maxManagedSkills?: number;
    beforeCommit?: () => Promise<void>;
}
export declare class SkillConflictError extends Error {
    readonly code = "AUTOSKILL_SKILL_CONFLICT";
}
/** Markdown is shareable; source evidence, usage controls and versions are private. */
export declare class SkillStore {
    readonly root: string;
    private readonly skillsRoot;
    private readonly stateRoot;
    constructor(root: string);
    private directory;
    private regularFile;
    private privateDirectory;
    private sourcePath;
    private controlPath;
    private pendingPath;
    private json;
    private source;
    private control;
    private recover;
    private migrateLegacy;
    private entry;
    list(): Promise<StoredSkill[]>;
    private find;
    private lock;
    private atomicFile;
    private backup;
    private publish;
    save(decision: ReviewDecision, provenance: ReviewProvenance, options?: SaveOptions): Promise<{
        path: string;
        id: string;
        changed: boolean;
        sha256: string;
        version: string;
    }>;
    inspect(id: string): Promise<{
        skill: StoredSkill;
        versions: string[];
        provenance?: unknown;
    }>;
    private updateControl;
    pin(id: string, pinned?: boolean): Promise<StoredSkill>;
    recordUsage(id: string): Promise<StoredSkill>;
    feedback(id: string, input: {
        outcome: "success" | "failure";
        notes?: string;
    }): Promise<StoredSkill>;
    archive(id: string, options?: {
        expectedHash?: string;
        signal?: AbortSignal;
    }): Promise<StoredSkill>;
    restore(id: string, version?: string): Promise<StoredSkill>;
    /** Explicit user action accepts current Markdown as the new automation baseline. */
    adopt(id: string): Promise<StoredSkill>;
}
