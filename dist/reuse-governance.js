import * as path from "node:path";
import { SkillStore, SkillConflictError } from "./skills.js";
export const GOVERNANCE_POLICY_VERSION = "governance-v1";
function hash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function dateFromRevision(value) {
    if (!value)
        return undefined;
    const iso = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(value);
    const at = iso ? Date.parse(`${iso[1]}:${iso[2]}:${iso[3]}.${iso[4]}Z`) : Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
}
function observedAt(skill) {
    const last = skill.lastUsedAt ? Date.parse(skill.lastUsedAt) : undefined;
    return last !== undefined && Number.isFinite(last) ? last : dateFromRevision(skill.version);
}
function normalizedContent(content) {
    if (!content)
        return undefined;
    const normalized = content.replace(/^\s*autoskill-revision:\s*.*$/gim, "")
        .replace(/^\s*autoskill-version:\s*.*$/gim, "")
        .replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return normalized.length >= 40 ? normalized : undefined;
}
function procedure(content) {
    const match = (content?.match(/^##\s+Procedure\s*\n([\s\S]*?)(?=^##\s)/im)?.[1] ?? content?.match(/^##\s+Procedure\s*\n([\s\S]*)/im)?.[1])
        ?.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    return match && match.length >= 32 ? match : undefined;
}
function selectCanonical(skills) {
    return [...skills].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.usageCount ?? 0) - (a.usageCount ?? 0) || a.id.localeCompare(b.id))[0];
}
function statsFor(skill, stats) {
    const sha256 = hash(skill.sha256);
    return sha256 ? stats.find((item) => item.skillId === skill.id && item.sha256 === sha256) : undefined;
}
/** Pure governance plan: it never edits a skill and never combines unverified content. */
export function planReuseGovernance(skills, stats, options = {}) {
    const now = options.now ?? Date.now(), failureCount = options.archiveFailureCount ?? 3, successRate = options.archiveSuccessRate ?? 0.25;
    const staleDays = options.staleAfterDays ?? 180;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(failureCount) || failureCount < 1 || !Number.isFinite(successRate) || successRate < 0 || successRate > 1 || !Number.isFinite(staleDays) || staleDays < 1)
        throw new Error("Invalid reuse governance policy.");
    const active = skills.filter((skill) => !skill.archived && hash(skill.sha256));
    const suggestions = [];
    for (const skill of active) {
        const currentHash = hash(skill.sha256);
        const stat = statsFor(skill, stats);
        const feedback = stat?.userFeedback ?? { success: 0, failure: 0 };
        const denominator = feedback.success + feedback.failure;
        const negative = feedback.failure >= failureCount && denominator > 0 && feedback.success / denominator <= successRate;
        const at = observedAt(skill), stale = at !== undefined && now - at >= staleDays * 86_400_000;
        if (skill.managed && skill.ownership === "managed" && !skill.pinned && ((negative) || (stale && feedback.failure >= 1))) {
            suggestions.push({ kind: "archive", skillId: skill.id, sha256: currentHash,
                reasonCodes: [...(negative ? ["repeated_user_failures"] : []), ...(stale ? ["stale_with_user_failure"] : [])],
                userFeedback: feedback, lastObservedAt: at });
        }
    }
    const groups = new Map();
    for (const skill of active) {
        const body = normalizedContent(skill.content), steps = procedure(skill.content);
        if (body)
            groups.set(`body:${body}`, [...(groups.get(`body:${body}`) ?? []), skill]);
        if (steps)
            groups.set(`procedure:${steps}`, [...(groups.get(`procedure:${steps}`) ?? []), skill]);
    }
    const aliases = new Set();
    for (const group of groups.values())
        if (group.length > 1) {
            const canonical = selectCanonical(group);
            for (const skill of group.filter((item) => item.id !== canonical.id)) {
                const key = `${skill.id}\0${canonical.id}`;
                if (aliases.has(key))
                    continue;
                aliases.add(key);
                suggestions.push({ kind: "duplicate-alias", skillId: skill.id, sha256: hash(skill.sha256), canonicalId: canonical.id,
                    relatedIds: group.map((item) => item.id), reasonCodes: ["duplicate_coverage"] });
            }
        }
    return { policyVersion: GOVERNANCE_POLICY_VERSION, generatedAt: now, considered: skills.length, suggestions: suggestions.sort((a, b) => a.skillId.localeCompare(b.skillId) || a.kind.localeCompare(b.kind)) };
}
/** Apply only archive recommendations, with a second ownership/hash/pin check inside SkillStore's lock. */
export async function applyReuseGovernance(root, plan, options = {}) {
    if (plan.policyVersion !== GOVERNANCE_POLICY_VERSION)
        throw new Error("Unsupported reuse governance plan version.");
    const store = new SkillStore(path.resolve(root));
    const result = { dryRun: options.dryRun === true, applied: [], skipped: [] };
    for (const suggestion of plan.suggestions) {
        options.signal?.throwIfAborted();
        if (suggestion.kind !== "archive") {
            result.skipped.push({ skillId: suggestion.skillId, action: suggestion.kind, reason: "duplicate alias is advisory; no skill body is changed" });
            continue;
        }
        let current;
        try {
            current = await store.inspect(suggestion.skillId).then((value) => value.skill);
        }
        catch {
            result.skipped.push({ skillId: suggestion.skillId, action: suggestion.kind, reason: "skill no longer exists" });
            continue;
        }
        if (current.archived || current.ownership !== "managed" || current.pinned || current.sha256 !== suggestion.sha256) {
            result.skipped.push({ skillId: suggestion.skillId, action: suggestion.kind, reason: "ownership, pin or content hash changed" });
            continue;
        }
        if (result.dryRun) {
            result.applied.push({ skillId: suggestion.skillId, action: "archive" });
            continue;
        }
        try {
            const archive = store.archive;
            await archive.call(store, suggestion.skillId, { expectedHash: suggestion.sha256, signal: options.signal });
            result.applied.push({ skillId: suggestion.skillId, action: "archive" });
        }
        catch (error) {
            result.skipped.push({ skillId: suggestion.skillId, action: suggestion.kind, reason: error instanceof SkillConflictError ? "skill changed during archive" : "archive failed" });
        }
    }
    return result;
}
//# sourceMappingURL=reuse-governance.js.map