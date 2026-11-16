import type { ToolRecord } from "./types.js";
/** Redact decoded JSON leaves before serialization, including entire credential fields. */
export declare function redactValue<T>(value: T, root?: string): T;
/** Detect secrets on decoded values, so JSON escaping cannot hide or corrupt them. */
export declare function containsSecretValue(value: unknown): boolean;
export declare function redact(text: string, root?: string): string;
export declare function containsSecret(text: string): boolean;
export declare function truncate(text: string, max: number): string;
export interface PrivacyFilterOptions {
    root: string;
    excludeTools?: string[];
    excludeFiles?: string[];
    sensitivePatterns?: string[];
}
/** Drop high-sensitivity operations entirely; redaction alone is not an access policy. */
export declare function sanitizeTool(tool: ToolRecord, options: PrivacyFilterOptions): ToolRecord | undefined;
