import type { ToolRecord } from "../types.js";
export type HostId = "claude-code" | "codex" | "gemini" | "cursor" | "generic";
export type HookKind = "task-start" | "tool-start" | "tool-result" | "task-end" | "session-start" | "subagent-start" | "subagent-end" | "ignored";
export interface HookCoverage {
    source: "hook";
    transcript: "not-read";
    tools: "observed" | "partial" | "none";
    reasons: string[];
}
export interface NormalizedHook {
    host: HostId;
    sessionId: string;
    turnId?: string;
    messageId?: string;
    cwd: string;
    eventId?: string;
    kind: HookKind;
    eventName: string;
    prompt?: string;
    assistantText?: string;
    tool?: ToolRecord;
    terminal?: "success" | "failure" | "interrupted" | "unknown";
    /** Execution ended; does not establish task completion or successful verification. */
    executionCompleted?: boolean;
    origin?: "user" | "subagent" | "maintenance" | "unknown";
    parentId?: string;
    agentId?: string;
    coverage: HookCoverage;
}
export interface AdapterCapabilities {
    host: HostId;
    hooks: readonly string[];
    promptContextInjection: boolean;
    sessionContextInjection: boolean;
    toolEvidence: boolean;
    taskBoundary: boolean;
    nativeSkillDirectory?: string;
    refresh: "watch" | "reload-command" | "next-session" | "none";
    limitations: readonly string[];
}
export type HookInput = Record<string, unknown>;
export declare const MAX_HOOK_TEXT = 64000;
export declare function record(value: unknown): HookInput | undefined;
export declare function identifier(value: unknown): string | undefined;
export declare function boundedText(value: unknown, limit?: number): string | undefined;
export declare function inputRecord(value: unknown): HookInput;
/** Keep only bounded JSON data. Never preserve hidden reasoning or encoded media. */
export declare function boundedValue(value: unknown): unknown;
export declare function toolOutput(value: unknown): string;
export declare function baseHook(host: HostId, input: HookInput, session?: unknown, turn?: unknown): NormalizedHook;
export declare function hookOrigin(input: HookInput): NormalizedHook["origin"];
export declare function taskStart(event: NormalizedHook, input: HookInput): NormalizedHook;
export declare function normalizedTool(event: NormalizedHook, input: HookInput, output: unknown, failed?: boolean): NormalizedHook;
/** Categories describe observed operations. A test-looking name never proves verification. */
export declare function toolCategory(name: string): ToolRecord["category"];
export declare function normalizedToolStart(event: NormalizedHook, input: HookInput): NormalizedHook;
export declare function subagentHook(event: NormalizedHook, ending?: boolean): NormalizedHook;
export declare function capabilitiesFor(host: HostId): AdapterCapabilities;
export declare function normalizeHook(host: HostId, value: unknown): NormalizedHook;
/** Never ask a completion hook to continue a finished conversation. */
export declare function hookResponse(host: HostId, eventName: string, context?: string): Record<string, unknown>;
