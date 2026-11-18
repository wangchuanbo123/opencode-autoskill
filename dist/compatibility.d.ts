import type { ExistingSkill, SkillCompatibility, SkillContent } from "./types.js";
export declare const COMPATIBILITY_HOSTS: readonly ["opencode", "claude-code", "codex", "gemini", "cursor", "generic"];
export declare function normalizeCompatibility(value: unknown): SkillCompatibility | undefined;
export declare function compatibilityReasons(skill: Pick<ExistingSkill, "compatibility" | "compatibilityInvalid">, host?: string, capabilities?: readonly string[]): string[];
/** Explicit native plugin API references are not portable procedures. Ordinary shell commands are not inferred. */
export declare function constrainNativeSkill(skill: SkillContent): SkillCompatibility | undefined;
