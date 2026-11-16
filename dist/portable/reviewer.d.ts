import type { ModelRef } from "../types.js";
export interface ReviewerConfig {
    type: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv?: string;
    maxOutputTokens?: number;
}
export declare function reviewerStatus(config?: ReviewerConfig): {
    available: boolean;
    reasonCode?: string;
};
export declare function validateReviewer(config: ReviewerConfig): URL;
/** An explicit provider configuration never reads the host's private login files. */
export declare function generateReview(config: ReviewerConfig | undefined, input: {
    prompt: string;
    signal: AbortSignal;
    model?: ModelRef;
}): Promise<string>;
