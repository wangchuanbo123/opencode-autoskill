export type ReuseOutcome = "success" | "failure" | "interrupted" | "unknown";
export type ReuseFeedback = "success" | "failure" | "unknown";
export type ReuseReportSource = "user" | "model";
export interface ReuseTaskIdentity {
    sessionId: string;
    anchorId: string;
    queryHash?: string;
}
export interface ReuseSkillIdentity extends ReuseTaskIdentity {
    skillId: string;
    sha256: string;
}
export interface ReuseOfferedSkill {
    skillId: string;
    sha256: string;
    score: number;
    reasonCodes?: string[];
}
export interface ReuseSearch extends ReuseTaskIdentity {
    candidates: ReuseOfferedSkill[];
    policyVersion?: string;
    excludedSkillIds?: string[];
}
export interface ReuseSkillRecord {
    skillId: string;
    sha256: string;
    offered: boolean;
    score?: number;
    reasonCodes: string[];
    loaded: boolean;
    loadSource?: "automatic" | "explicit" | "native";
    nativeLoadObserved: boolean;
    /** A user/model report of applying the skill; loading alone does not establish use. */
    used: boolean;
    useSource?: ReuseReportSource;
    feedback: ReuseFeedback;
    feedbackSource?: ReuseReportSource;
    userFeedback?: ReuseFeedback;
    modelFeedback?: ReuseFeedback;
}
export interface ReuseTaskRecord {
    taskId: string;
    sessionId?: string;
    anchorId?: string;
    queryHash?: string;
    excludedSkillIds: string[];
    searched: boolean;
    policyVersion?: string;
    outcome: ReuseOutcome;
    outcomeAt?: number;
    createdAt: number;
    updatedAt: number;
    compacted: boolean;
    skills: ReuseSkillRecord[];
}
export interface ReuseSkillStats {
    skillId: string;
    sha256: string;
    offered: number;
    loaded: number;
    nativeLoaded: number;
    reportedUsed: number;
    feedback: {
        success: number;
        failure: number;
        unknown: number;
    };
    userFeedback: {
        success: number;
        failure: number;
    };
    modelFeedback: {
        success: number;
        failure: number;
    };
    taskOutcomes: Record<ReuseOutcome, number>;
    lastLoadedAt?: number;
}
export declare function reuseTaskId(input: ReuseTaskIdentity): string;
/** Private, version-specific task ledger. Task outcome is never converted into causal skill feedback. */
export declare class ReuseStore {
    readonly root: string;
    readonly file: string;
    private opening?;
    private serial;
    private closing?;
    constructor(root: string);
    private database;
    private transaction;
    private ensureTask;
    private resolveTaskId;
    private ensureSkill;
    private touch;
    private readTask;
    recordSearch(input: ReuseSearch, signal?: AbortSignal): Promise<ReuseTaskRecord>;
    recordLoad(input: ReuseSkillIdentity & {
        source: "automatic" | "explicit";
        maxLoaded?: number;
    }, signal?: AbortSignal): Promise<ReuseTaskRecord>;
    observeNativeLoad(input: ReuseSkillIdentity & {
        toolCallId: string;
    }, signal?: AbortSignal): Promise<ReuseTaskRecord>;
    recordUse(input: ReuseSkillIdentity & {
        source: ReuseReportSource;
    }, signal?: AbortSignal): Promise<ReuseTaskRecord>;
    finishTask(input: ReuseTaskIdentity & {
        outcome: ReuseOutcome;
        finishedAt?: number;
    }, signal?: AbortSignal): Promise<ReuseTaskRecord | undefined>;
    /** Explicit skill feedback stays separate from task outcome and retains its reporting source. */
    feedback(input: ReuseSkillIdentity & {
        outcome: ReuseFeedback;
        source: ReuseReportSource;
    }, signal?: AbortSignal): Promise<ReuseTaskRecord>;
    inspect(identity: ReuseTaskIdentity): Promise<ReuseTaskRecord | undefined>;
    getTask(identity: ReuseTaskIdentity): Promise<ReuseTaskRecord | undefined>;
    currentTask(sessionId: string): Promise<ReuseTaskRecord | undefined>;
    history(skillId?: string, sha256?: string): Promise<ReuseSkillStats[]>;
    status(limit?: number): Promise<{
        searchedTasks: number;
        loadedTasks: number;
        reportedUsedTasks: number;
        recent: ReuseTaskRecord[];
    }>;
    /** Bound detailed history; tiny version/stage/feedback tombstones retain deduplication and aggregates. */
    compact(options?: {
        keepRecentTasks?: number;
        olderThanDays?: number;
    }, signal?: AbortSignal): Promise<number>;
    close(): Promise<void>;
}
