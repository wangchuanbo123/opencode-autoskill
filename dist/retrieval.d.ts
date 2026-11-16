import type { ExistingSkill } from "./types.js";
export declare const REUSE_POLICY_VERSION = "retrieval-v1";
/** Optional structured constraints are authoritative only after ownership/hash checks. */
export interface RetrievalSkill extends ExistingSkill {
    whenToUse?: string[];
    prerequisites?: string[];
    verification?: string[];
    updatedAt?: string;
    expiresAt?: string;
    tags?: string[];
    conflictGroup?: string;
    supersedes?: string[];
}
export interface ReuseEnvironment {
    technologies?: string[];
    runtimeVersions?: Record<string, string>;
    platform?: string;
    /** Explicitly observed project facts, never claims copied from the task text. */
    facts?: string[];
}
export interface ReusePolicy {
    candidateLimit?: number;
    autoLoadLimit?: number;
    minScore?: number;
    autoLoadScore?: number;
    staleAfterDays?: number;
    now?: number;
    sensitivePatterns?: string[];
}
export interface ReuseCandidate {
    id: string;
    title: string;
    description: string;
    score: number;
    match: "high" | "possible";
    autoLoad: boolean;
    reasonCodes: string[];
    sha256: string;
    version?: string;
}
export interface ReuseSelection {
    policyVersion: typeof REUSE_POLICY_VERSION;
    candidates: ReuseCandidate[];
    autoLoadIds: string[];
    exclusions: {
        id: string;
        reasonCodes: string[];
    }[];
    scanned: number;
    duplicateGroups: string[][];
}
/** Keep task admission and later retrieval tools aligned with the user's opt-out. */
export declare function isReuseOptOut(task: string): boolean;
/** Local routing and bounded summaries. Scores do not prove semantic suitability. */
export declare function selectReuseSkills(task: string, skills: RetrievalSkill[], environment?: ReuseEnvironment, policy?: ReusePolicy): ReuseSelection;
