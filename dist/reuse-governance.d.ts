import type { ReuseSkillStats } from "./reuse-store.js";
import type { ExistingSkill } from "./types.js";
export declare const GOVERNANCE_POLICY_VERSION = "governance-v1";
export type GovernanceSuggestionKind = "archive" | "duplicate-alias";
export interface GovernanceSuggestion {
    kind: GovernanceSuggestionKind;
    skillId: string;
    sha256: string;
    reasonCodes: string[];
    canonicalId?: string;
    relatedIds?: string[];
    userFeedback?: {
        success: number;
        failure: number;
    };
    lastObservedAt?: number;
}
export interface ReuseGovernancePlan {
    policyVersion: typeof GOVERNANCE_POLICY_VERSION;
    generatedAt: number;
    considered: number;
    suggestions: GovernanceSuggestion[];
}
export interface ReuseGovernanceOptions {
    now?: number;
    archiveFailureCount?: number;
    archiveSuccessRate?: number;
    staleAfterDays?: number;
}
export interface ApplyReuseGovernanceOptions {
    dryRun?: boolean;
    signal?: AbortSignal;
}
export interface ApplyReuseGovernanceResult {
    dryRun: boolean;
    applied: {
        skillId: string;
        action: "archive";
    }[];
    skipped: {
        skillId: string;
        action: GovernanceSuggestionKind;
        reason: string;
    }[];
}
/** Pure governance plan: it never edits a skill and never combines unverified content. */
export declare function planReuseGovernance(skills: ExistingSkill[], stats: ReuseSkillStats[], options?: ReuseGovernanceOptions): ReuseGovernancePlan;
/** Apply only archive recommendations, with a second ownership/hash/pin check inside SkillStore's lock. */
export declare function applyReuseGovernance(root: string, plan: ReuseGovernancePlan, options?: ApplyReuseGovernanceOptions): Promise<ApplyReuseGovernanceResult>;
