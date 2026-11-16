import type { AutoSkillOptions, TaskSnapshot } from "./types.js";
export declare const COMPLEXITY_POLICY_VERSION = "evidence-v1";
export interface ComplexityDimension {
    present: boolean;
    points: number;
    toolCallIds: string[];
}
/** A routing heuristic for semantic review, never a proof of complexity or reuse. */
export interface ComplexityAssessment {
    version: typeof COMPLEXITY_POLICY_VERSION;
    eligible: boolean;
    score: number;
    threshold: number;
    logicalSteps: number;
    uniqueOperations: number;
    repeatedOperations: number;
    successfulEvidenceCount: number;
    dimensions: Record<"dependencyChain" | "diagnosticResolution" | "crossResourceCoordination" | "investigation" | "decisionEvidence" | "verification" | "operationDiversity", ComplexityDimension>;
    signals: string[];
    reasonCodes: string[];
}
export declare function assessComplexity(snapshot: TaskSnapshot, options: AutoSkillOptions): ComplexityAssessment;
