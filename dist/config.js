export const defaults = {
    enabled: true,
    agentPolicy: "root-only",
    minToolCalls: 8,
    minToolCallsWithErrors: 4,
    debounceMs: 2_000,
    cooldownMs: 60_000,
    maxReviewsPerDay: 20,
    reviewTimeoutMs: 90_000,
    maxTranscriptChars: 60_000,
    maxToolOutputChars: 6_000,
    maxSkillChars: 16_000,
    minConfidence: 0.85,
    maxAttempts: 2,
    language: "zh-CN",
    mode: "auto", minComplexityScore: 11, maxPromptChars: 80_000, maxEstimatedInputTokens: 40_000,
    relevantSkillLimit: 8, maxManagedSkills: 100, maxGlobalReviewsPerDay: 100,
    maxEstimatedTokensPerDay: 250_000, maxGlobalEstimatedTokensPerDay: 1_000_000,
    retryBaseMs: 5_000, retryMaxMs: 300_000,
    providerAllowlist: [], excludeTools: [], excludeSessions: [], sensitivePatterns: [],
    excludeFiles: [".env", ".env.*", "*.pem", "*.key", "**/credentials*", "**/auth.json", "**/secrets/**"],
    storeEvidence: "redacted",
    reuseEnabled: true, reuseCandidateLimit: 5, reuseAutoLoadLimit: 2, reuseMinScore: 0.16, reuseAutoLoadScore: 0.62,
    reuseStaleAfterDays: 180, reuseMaxContextChars: 16_000, reuseMaxSkillChars: 6_000, reuseTimeoutMs: 5_000,
};
export function readOptions(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("AutoSkill options must be an object.");
    const known = new Set([...Object.keys(defaults), "model", "globalStateDirectory"]);
    const unknown = Object.keys(input).filter((key) => !known.has(key));
    if (unknown.length)
        throw new Error(`Unknown AutoSkill option(s): ${unknown.join(", ")}`);
    const output = structuredClone(defaults);
    const ranges = {
        minToolCalls: [1, 1_000], minToolCallsWithErrors: [1, 1_000],
        debounceMs: [0, 60_000], cooldownMs: [0, 86_400_000],
        maxReviewsPerDay: [1, 1_000], reviewTimeoutMs: [100, 300_000],
        maxTranscriptChars: [2_000, 200_000], maxToolOutputChars: [100, 20_000],
        maxSkillChars: [500, 50_000], minConfidence: [0.5, 1], maxAttempts: [1, 5],
        minComplexityScore: [1, 100], maxPromptChars: [8_000, 300_000], maxEstimatedInputTokens: [2_000, 150_000],
        relevantSkillLimit: [1, 30], maxManagedSkills: [1, 10_000], maxGlobalReviewsPerDay: [1, 10_000],
        maxEstimatedTokensPerDay: [2_000, 10_000_000], maxGlobalEstimatedTokensPerDay: [2_000, 100_000_000],
        retryBaseMs: [10, 300_000], retryMaxMs: [10, 86_400_000],
        reuseCandidateLimit: [1, 10], reuseAutoLoadLimit: [0, 2], reuseMinScore: [0, 1], reuseAutoLoadScore: [0, 1],
        reuseStaleAfterDays: [1, 3650], reuseMaxContextChars: [2000, 64_000], reuseMaxSkillChars: [500, 32_000], reuseTimeoutMs: [100, 30_000],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
        if (input[key] === undefined)
            continue;
        const value = input[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max ||
            (!["minConfidence", "reuseMinScore", "reuseAutoLoadScore"].includes(key) && !Number.isInteger(value))) {
            throw new Error(`Invalid AutoSkill option ${key}: expected ${min}..${max}`);
        }
        Object.assign(output, { [key]: value });
    }
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean")
            throw new Error("enabled must be boolean");
        output.enabled = input.enabled;
    }
    if (input.agentPolicy !== undefined) {
        if (typeof input.agentPolicy !== "string" || !["root-only", "inherit", "independent"].includes(input.agentPolicy))
            throw new Error("agentPolicy must be root-only, inherit or independent.");
        output.agentPolicy = input.agentPolicy;
    }
    if (input.reuseEnabled !== undefined) {
        if (typeof input.reuseEnabled !== "boolean")
            throw new Error("reuseEnabled must be boolean");
        output.reuseEnabled = input.reuseEnabled;
    }
    if (output.reuseAutoLoadScore < output.reuseMinScore)
        throw new Error("reuseAutoLoadScore must be >= reuseMinScore.");
    if (output.reuseAutoLoadLimit > output.reuseCandidateLimit)
        throw new Error("reuseAutoLoadLimit must not exceed reuseCandidateLimit.");
    if (input.language !== undefined) {
        if (typeof input.language !== "string" || !/^[a-zA-Z0-9-]{2,30}$/.test(input.language))
            throw new Error("Invalid language code");
        output.language = input.language;
    }
    for (const key of ["providerAllowlist", "excludeTools", "excludeFiles", "excludeSessions", "sensitivePatterns"]) {
        if (input[key] === undefined)
            continue;
        const values = input[key];
        if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value || value.length > 300 || value.includes("\0"))) {
            throw new Error(`${key} must be an array of bounded nonempty strings.`);
        }
        output[key] = [...values];
    }
    for (const pattern of output.sensitivePatterns)
        if (pattern.length < 3)
            throw new Error("sensitivePatterns entries must contain at least 3 literal characters.");
    if (input.mode !== undefined) {
        if (input.mode !== "auto" && input.mode !== "draft")
            throw new Error("mode must be auto or draft");
        output.mode = input.mode;
    }
    if (input.storeEvidence !== undefined) {
        if (input.storeEvidence !== "none" && input.storeEvidence !== "redacted")
            throw new Error("storeEvidence must be none or redacted");
        output.storeEvidence = input.storeEvidence;
    }
    if (input.globalStateDirectory !== undefined) {
        if (typeof input.globalStateDirectory !== "string" || !input.globalStateDirectory.trim() || input.globalStateDirectory.includes("\0"))
            throw new Error("Invalid globalStateDirectory");
        output.globalStateDirectory = input.globalStateDirectory;
    }
    if (input.model !== undefined) {
        const model = input.model;
        if (!model || typeof model.providerID !== "string" || typeof model.id !== "string" || !model.providerID || !model.id || Object.keys(model).some((key) => key !== "providerID" && key !== "id")) {
            throw new Error("model must contain providerID and id");
        }
        output.model = { providerID: model.providerID, id: model.id };
    }
    if (output.retryMaxMs < output.retryBaseMs)
        throw new Error("retryMaxMs must be at least retryBaseMs");
    return output;
}
//# sourceMappingURL=config.js.map