export const COMPATIBILITY_HOSTS = ["opencode", "claude-code", "codex", "gemini", "cursor", "generic"];
export function normalizeCompatibility(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["hosts", "requiredCapabilities"].includes(key)))
        throw new Error("Invalid skill compatibility metadata.");
    const input = value, output = {};
    if (input.hosts !== undefined) {
        if (!Array.isArray(input.hosts) || !input.hosts.length || input.hosts.length > COMPATIBILITY_HOSTS.length || input.hosts.some(host => typeof host !== "string" || !COMPATIBILITY_HOSTS.includes(host)))
            throw new Error("Invalid skill compatibility hosts.");
        output.hosts = [...new Set(input.hosts)].sort();
    }
    if (input.requiredCapabilities !== undefined) {
        if (!Array.isArray(input.requiredCapabilities) || !input.requiredCapabilities.length || input.requiredCapabilities.length > 32 || input.requiredCapabilities.some(capability => typeof capability !== "string" || capability.length > 80 || !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/.test(capability)))
            throw new Error("Invalid skill required capabilities.");
        output.requiredCapabilities = [...new Set(input.requiredCapabilities)].sort();
    }
    return Object.keys(output).length ? output : undefined;
}
export function compatibilityReasons(skill, host, capabilities = []) {
    if (skill.compatibilityInvalid)
        return ["invalid_compatibility"];
    let compatibility;
    try {
        compatibility = normalizeCompatibility(skill.compatibility);
    }
    catch {
        return ["invalid_compatibility"];
    }
    if (!compatibility)
        return [];
    const reasons = [];
    if (compatibility.hosts && (!host || !compatibility.hosts.includes(host)))
        reasons.push(host ? "host_incompatible" : "host_unconfirmed");
    if (compatibility.requiredCapabilities?.some(capability => !capabilities.includes(capability)))
        reasons.push("required_capability_unconfirmed");
    return reasons;
}
/** Explicit native plugin API references are not portable procedures. Ordinary shell commands are not inferred. */
export function constrainNativeSkill(skill) {
    const compatibility = normalizeCompatibility(skill.compatibility);
    const body = [skill.description, ...skill.whenToUse, ...skill.prerequisites, ...skill.steps, ...skill.pitfalls, ...skill.verification].join("\n");
    if (/@opencode\/plugin\b|\bctx\.(?:session|experimental\.generate|tool\.transform|skill)\b|\bOpenCode\s+(?:server[- ]side\s+)?plugin\s+API\b|OpenCode\s*插件(?:接口|API)/i.test(body)) {
        if (compatibility?.hosts?.some(host => host !== "opencode"))
            throw new Error("OpenCode native plugin APIs require opencode-only compatibility.");
        return { ...compatibility, hosts: ["opencode"] };
    }
    return compatibility;
}
//# sourceMappingURL=compatibility.js.map