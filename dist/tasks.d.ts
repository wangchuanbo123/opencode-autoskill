import type { AutoSkillOptions, ConversationMessage, TaskSnapshot } from "./types.js";
export declare const digest: (value: unknown) => string;
/** Keep native IDs for host lookups; use this identity only in shared state. */
export declare function scopedSessionId(sessionId: string, hostId?: string, workspaceId?: string): string;
export declare function completedForReview(snapshot: Pick<TaskSnapshot, "terminal" | "executionCompleted">): boolean;
export interface TaskPacket {
    id: string;
    taskId: string;
    anchorId: string;
    fingerprint: string;
    snapshot: TaskSnapshot;
    coverage: string[];
    eligible: boolean;
    reasonCode?: string;
}
export declare function taskMessages(messages: ConversationMessage[]): ConversationMessage[];
export declare function matchesSession(sessionId: string, excluded: string[]): boolean;
/** Preserve every allowed tool in a bounded packet, with final checks shared between packets. */
export declare function collectTasks(snapshot: TaskSnapshot, options: AutoSkillOptions, root: string): TaskPacket[];
export { assessComplexity, COMPLEXITY_POLICY_VERSION, type ComplexityAssessment, type ComplexityDimension } from "./complexity.js";
