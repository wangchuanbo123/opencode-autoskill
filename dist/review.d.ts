import type { AutoSkillOptions, ConversationMessage, ExistingSkill, ReviewDecision, TaskSnapshot, ToolRecord } from "./types.js";
export { taskMessages } from "./tasks.js";
export declare function fingerprint(messages: ConversationMessage[]): string;
export interface ReviewInput {
    prompt: string;
    evidence: Map<string, ToolRecord>;
    hasUserTask: boolean;
    updateableIds: Set<string>;
    estimatedInputTokens: number;
    templateHash: string;
    relevantSkillIds: string[];
}
export interface ReviewContext {
    preScreen?: unknown;
    hostId?: string;
    hostCapabilities?: string[];
}
export declare function terms(text: string): Set<string>;
export declare function selectRelevantSkills(snapshot: TaskSnapshot, skills: ExistingSkill[], limit: number): ExistingSkill[];
export declare const estimateInputTokens: (text: string) => number;
/** Keep every packet tool and its user goal; shrink outputs rather than dropping whole messages. */
export declare function buildReviewInput(snapshot: TaskSnapshot, skills: ExistingSkill[], options: AutoSkillOptions, root: string, context?: ReviewContext): Promise<ReviewInput>;
export declare function parseReviewJson(text: string): unknown;
export declare function parseDecision(text: string, evidence: Map<string, ToolRecord>, skills: ExistingSkill[], options: AutoSkillOptions, root: string): ReviewDecision;
