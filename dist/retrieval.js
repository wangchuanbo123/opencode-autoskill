import { containsSecretValue } from "./safety.js";
export const REUSE_POLICY_VERSION = "retrieval-v1";
const stop = new Set(("a an and are as at be been by can could do does done for from help how i if in into is it its just me my of on or our please should so some task than that the their them then there these they this to use using want was we what when which will with would you your fix fixes fixing find check checks test tests testing run runs execute execution process project projects code codes problem problems issue issues error errors failure failures failed solution solutions skill skills method methods procedure procedures workflow workflows result results generic general implement improve need needed update new existing read write inspect verify verified verification successfully successful" +
    " 修复 处理 问题 任务 系统 检查 执行 测试 配置 使用 需要 请帮 帮我 代码 进行 自动 技能 经验 方法 情况 如何 这个 一个 已有 新的 结果 验证 成功 解决 优化 项目 查找 分析 排查 实现 相关 通用 功能 完成 请你 现在 时候").split(/\s+/));
const aliases = [
    [/数据库/g, "database"], [/缓存/g, "cache"], [/迁移/g, "migration"], [/租户/g, "tenant"], [/重试/g, "retry"],
    [/死锁/g, "deadlock"], [/锁/g, "lock"], [/发票/g, "invoice"], [/契约/g, "contract"], [/解码/g, "decoder"],
    [/并发/g, "concurrent"], [/碰撞|冲突/g, "collision"], [/对账/g, "reconciliation"], [/事务/g, "transaction"], [/路由/g, "router"],
];
const runtimeNames = ["node", "python", "bun", "deno", "java", "php", "ruby", "go", "rust", "dotnet"];
const technologyNames = ["react", "vue", "angular", "svelte", "nextjs", "django", "fastapi", "flask", "express", "postgresql", "mysql", "sqlite", "redis", "mongodb", ...runtimeNames];
const platform = (value) => /^(?:windows|win32|win64)$/i.test(value) ? "windows" : /^(?:darwin|macos|mac|osx)$/i.test(value) ? "macos" : value.toLowerCase();
function canonical(text) {
    return text.toLowerCase().normalize("NFKC").replace(/node\.js/g, "node").replace(/next\.js/g, "nextjs").replace(/postgres\b/g, "postgresql").replace(/\.net\b/g, "dotnet");
}
function tokens(text) {
    const normalized = canonical(text);
    const output = new Set();
    for (const word of normalized.match(/[a-z][a-z0-9_.-]+/g) ?? []) {
        for (const part of word.split(/[_\W]+/).filter(Boolean))
            if (part.length > 1 && !stop.has(part))
                output.add(part.replace(/(?:ing|ed|s)$/, (suffix) => part.length > 6 ? "" : suffix));
    }
    for (const word of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
        for (let index = 0; index < word.length - 1; index++) {
            const pair = word.slice(index, index + 2);
            if (!stop.has(pair))
                output.add(pair);
        }
    }
    for (const [pattern, alias] of aliases) {
        pattern.lastIndex = 0;
        if (pattern.test(normalized))
            output.add(alias);
    }
    return output;
}
const normalizedText = (value) => canonical(value).replace(/[\s\p{P}\p{S}]/gu, "");
function section(content, headings) {
    if (!content)
        return [];
    const expression = new RegExp(`^##\\s+(?:${headings.join("|")})\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "im");
    const body = expression.exec(content)?.[1] ?? "";
    return body.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim()).filter((line) => line && !/^(?:none(?: recorded)?\.?|无|未记录)$/i.test(line));
}
function knownTechnologies(text) {
    const normalized = canonical(text);
    return technologyNames.filter((name) => new RegExp(`(?:^|[^a-z0-9])${name}(?:$|[^a-z0-9])`, "i").test(normalized));
}
function versionParts(value) {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][a-z0-9.-]+)?$/i.exec(value.trim());
    return match ? match.slice(1).filter((part) => part !== undefined).map(Number) : undefined;
}
function compare(left, right) {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference)
            return Math.sign(difference);
    }
    return 0;
}
function satisfies(actual, operator, wanted) {
    const left = versionParts(actual), right = versionParts(wanted);
    if (!left || !right)
        return undefined;
    const relation = compare(left, right);
    if (operator === ">=")
        return relation >= 0;
    if (operator === "<=")
        return relation <= 0;
    if (operator === ">")
        return relation > 0;
    if (operator === "<")
        return relation < 0;
    if (operator === "^")
        return relation >= 0 && left[0] === right[0] && (right[0] !== 0 || right.length < 2 || left[1] === right[1]) &&
            (right[0] !== 0 || right[1] !== 0 || right.length < 3 || left[2] === right[2]);
    if (operator === "~")
        return relation >= 0 && left[0] === right[0] && (right.length < 2 || left[1] === right[1]);
    return right.every((part, index) => left[index] === part);
}
function timestamp(skill) {
    const raw = skill.updatedAt ?? skill.version;
    if (!raw)
        return undefined;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed))
        return parsed;
    const day = /^(\d{4}-\d{2}-\d{2})T/.exec(raw)?.[1];
    return day ? Date.parse(`${day}T00:00:00.000Z`) : undefined;
}
function constraints(skill, environment) {
    const prerequisites = skill.prerequisites ?? section(skill.content, ["Prerequisites", "前提条件", "先决条件"]);
    const explicit = /(?:requires?|only (?:on|for|supports?)|must (?:use|have)|需要|必须|仅适用|仅支持)[^.!。\n]*/gi;
    const requirements = [...prerequisites, ...(canonical(skill.description).match(explicit) ?? [])];
    const technologies = new Set((environment.technologies ?? []).flatMap(knownTechnologies));
    const versions = new Map(Object.entries(environment.runtimeVersions ?? {}).map(([name, version]) => [canonical(name), version]));
    for (const name of versions.keys())
        technologies.add(name);
    const facts = new Set((environment.facts ?? []).map(normalizedText));
    const reasons = new Set();
    let incompatible = false, uncertain = false;
    for (const requirement of requirements) {
        if (facts.has(normalizedText(requirement)))
            continue;
        const normalized = canonical(requirement);
        let recognized = false;
        const requiredPlatforms = normalized.match(/\b(?:windows|win32|linux|macos|darwin)\b/g) ?? [];
        if (requiredPlatforms.length) {
            recognized = true;
            if (!environment.platform) {
                uncertain = true;
                reasons.add("platform_unconfirmed");
            }
            else if (!requiredPlatforms.map(platform).includes(platform(environment.platform))) {
                incompatible = true;
                reasons.add("platform_incompatible");
            }
        }
        for (const technology of knownTechnologies(requirement)) {
            recognized = true;
            if (!technologies.has(technology)) {
                uncertain = true;
                reasons.add("technology_unconfirmed");
            }
            // Known mutually exclusive application frameworks establish an actual
            // conflict; absent technology alone is not proof that it is unavailable.
            const families = [["react", "vue", "angular", "svelte"], ["django", "fastapi", "flask"], ["postgresql", "mysql", "sqlite"]];
            if (!technologies.has(technology) && families.some((family) => family.includes(technology) && family.some((item) => technologies.has(item)))) {
                incompatible = true;
                reasons.add("technology_incompatible");
            }
            if (!runtimeNames.includes(technology))
                continue;
            const tail = normalized.slice(normalized.indexOf(technology) + technology.length)
                .split(/\b(?:node|python|bun|deno|java|php|ruby|go|rust|dotnet|react|vue|angular|svelte|nextjs|django|fastapi|flask|express|postgresql|mysql|sqlite|redis|mongodb)\b/)[0];
            const head = /^\s*(?:version\s*)?(>=|<=|>|<|\^|~|=)?\s*v?(\d+(?:\.\d+){0,2})(\+)?/.exec(tail);
            if (!head)
                continue;
            const actual = versions.get(technology);
            if (!actual) {
                uncertain = true;
                reasons.add("runtime_version_unconfirmed");
                continue;
            }
            // Disjunctions and prose ranges require model judgment. Never pretend
            // a partial comparator parse proves compatibility for an entire range.
            if (/\|\||\bor\b|\bto\b|至/.test(tail)) {
                uncertain = true;
                reasons.add("runtime_range_unconfirmed");
                continue;
            }
            const firstOperator = head[3] ? ">=" : head[1] ?? "=";
            const conditions = [[firstOperator, head[2]]];
            const extra = tail.slice(head[0].length).matchAll(/(>=|<=|>|<|\^|~|=)\s*v?(\d+(?:\.\d+){0,2})/g);
            for (const match of extra)
                conditions.push([match[1], match[2]]);
            for (const [operator, wanted] of conditions) {
                const result = satisfies(actual, operator, wanted);
                if (result === false) {
                    incompatible = true;
                    reasons.add("runtime_version_incompatible");
                }
                if (result === undefined) {
                    uncertain = true;
                    reasons.add("runtime_version_unconfirmed");
                }
            }
        }
        const residual = normalized.replace(/\b(?:node|python|bun|deno|java|php|ruby|go|rust|dotnet|react|vue|angular|svelte|nextjs|django|fastapi|flask|express|postgresql|mysql|sqlite|redis|mongodb|windows|win32|linux|macos|darwin)\b/g, " ")
            .replace(/[<>=^~+|\d.]/g, " ").replace(/\b(?:a|an|the|and|or|with|on|for|in|use|using|requires?|only|must|have|version|runtime|installed|available|project|application|database|server)\b/g, " ").replace(/[\s\p{P}\p{S}]/gu, "");
        if (!recognized || residual) {
            uncertain = true;
            reasons.add("prerequisites_unconfirmed");
        }
    }
    return { incompatible, uncertain, reasons: [...reasons] };
}
function jaccard(left, right) {
    const intersection = [...left].filter((term) => right.has(term)).length;
    return intersection / Math.max(1, left.size + right.size - intersection);
}
/** Keep task admission and later retrieval tools aligned with the user's opt-out. */
export function isReuseOptOut(task) {
    return /(?:不要|禁止|不允许|无需|不用|别用)(?:自动)?(?:使用|加载|应用|参考)?(?:(?:任何|所有|已有|现有|自动|这些|的)\s*)*(?:技能|skills?)|(?:do not|don't|never)\s+(?:automatically\s+)?(?:load|use|apply)\s+(?:(?:any|existing|automatic|the)\s+)*(?:skills?|autoskill)\b|\bwithout\s+(?:using\s+)?(?:any\s+)?skills?\b/i.test(task);
}
/** Local routing and bounded summaries. Scores do not prove semantic suitability. */
export function selectReuseSkills(task, skills, environment = {}, policy = {}) {
    const result = { policyVersion: REUSE_POLICY_VERSION, candidates: [], autoLoadIds: [], exclusions: [], scanned: skills.length, duplicateGroups: [] };
    const candidateLimit = Math.max(1, Math.min(20, Math.floor(policy.candidateLimit ?? 5)));
    const autoLoadLimit = Math.max(0, Math.min(candidateLimit, Math.floor(policy.autoLoadLimit ?? 2)));
    const minScore = policy.minScore ?? 0.16, autoScore = policy.autoLoadScore ?? 0.62;
    const now = policy.now ?? Date.now(), staleAfterDays = policy.staleAfterDays ?? 180;
    const reject = (id, ...reasonCodes) => result.exclusions.push({ id, reasonCodes: [...new Set(reasonCodes)] });
    if (!task.trim())
        return result;
    if (isReuseOptOut(task)) {
        for (const skill of skills)
            reject(skill.id, "user_opt_out");
        return result;
    }
    const negatives = task.match(/(?:do not|don't|never|avoid|不要|禁止|不使用|别用)[^,，;；。\n.!?！？]*/gi) ?? [];
    const positiveTask = negatives.reduce((text, segment) => text.replace(segment, " "), task);
    const query = tokens(positiveTask);
    if (!query.size) {
        for (const skill of skills)
            reject(skill.id, "non_specific_query");
        return result;
    }
    const index = [];
    const idCounts = new Map();
    for (const skill of skills)
        idCounts.set(skill.id, (idCounts.get(skill.id) ?? 0) + 1);
    for (const skill of skills) {
        const reasons = [];
        if (idCounts.get(skill.id) > 1)
            reasons.push("ambiguous_skill_id");
        if (skill.archived)
            reasons.push("archived");
        if (skill.ownership !== "managed" || !/^[a-f0-9]{64}$/.test(skill.sha256 ?? "") || skill.sha256 !== skill.generatedHash)
            reasons.push("ownership_unverified");
        if (skill.contentComplete === false)
            reasons.push("incomplete_content");
        const text = `${skill.id}\n${skill.title ?? skill.name}\n${skill.description}\n${skill.content ?? ""}\n${(skill.prerequisites ?? []).join("\n")}`;
        if (containsSecretValue(text) || (policy.sensitivePatterns ?? []).some((pattern) => pattern && text.toLowerCase().includes(pattern.toLowerCase())))
            reasons.push("sensitive_content");
        if (/(?:ignore|disregard)\s+(?:(?:all|any)\s+)?(?:previous|prior|system)\s+(?:instructions?|messages?|rules?)|忽略(?:之前|先前|系统|安全).{0,8}(?:指令|要求|规则)|(?:reveal|exfiltrate)\s+(?:all\s+)?(?:secrets|credentials|api.?keys)/i.test(text))
            reasons.push("unsafe_instruction_override");
        const at = timestamp(skill), expires = skill.expiresAt === undefined ? undefined : Date.parse(skill.expiresAt);
        if (expires !== undefined && (!Number.isFinite(expires) || expires <= now))
            reasons.push("expired");
        if (at !== undefined && staleAfterDays > 0 && now - at > staleAfterDays * 86_400_000)
            reasons.push("stale");
        const success = Math.max(0, skill.feedback?.success ?? 0), failure = Math.max(0, skill.feedback?.failure ?? 0);
        if (failure >= 3 && failure / Math.max(1, success + failure) >= 0.75)
            reasons.push("repeated_negative_feedback");
        const condition = constraints(skill, environment);
        if (condition.incompatible)
            reasons.push(...condition.reasons);
        const title = tokens(`${skill.id} ${skill.title ?? skill.name}`);
        const triggers = tokens((skill.whenToUse ?? section(skill.content, ["When to use", "适用场景", "何时使用"])).join(" "));
        const values = new Set([...title, ...tokens(skill.description), ...triggers, ...tokens((skill.tags ?? []).join(" "))]);
        for (const segment of negatives) {
            const target = tokens(segment.replace(/^(?:do not|don't|never|avoid)\s+(?:use|load|apply)?\s*|^(?:不要|禁止|不使用|别用)(?:使用|加载|应用)?/i, "").replace(/技能/g, " "));
            const comparableTarget = [...target].filter((term) => !/[\p{Script=Han}]/u.test(term));
            if (comparableTarget.length)
                for (const term of [...target])
                    if (/[\p{Script=Han}]/u.test(term))
                        target.delete(term);
            if (target.size && [...target].every((term) => values.has(term)))
                reasons.push("user_excluded_topic");
        }
        if (reasons.length) {
            reject(skill.id, ...reasons);
            continue;
        }
        index.push({ skill, title, triggers, terms: values, procedure: normalizedText(section(skill.content, ["Procedure", "操作步骤", "步骤"]).join("\n")), constraints: condition, score: 0, reasons: [], auto: false });
    }
    const frequency = new Map();
    for (const item of index)
        for (const term of item.terms)
            frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const weight = (term) => Math.log(1 + (index.length + 1) / ((frequency.get(term) ?? 0) + 1));
    const coverage = (values) => {
        const all = [...values].reduce((sum, term) => sum + weight(term), 0);
        return [...values].filter((term) => query.has(term)).reduce((sum, term) => sum + weight(term), 0) / Math.max(1, all);
    };
    const queryWeight = [...query].reduce((sum, term) => sum + weight(term), 0);
    for (const item of index) {
        const matched = [...query].filter((term) => item.terms.has(term));
        let queryCoverage = matched.reduce((sum, term) => sum + weight(term), 0) / Math.max(1, queryWeight);
        const latinQuery = [...query].filter((term) => !/[\p{Script=Han}]/u.test(term));
        const latinMatch = matched.filter((term) => !/[\p{Script=Han}]/u.test(term));
        if (latinQuery.length >= 2 && latinMatch.length >= 2) {
            const comparable = latinMatch.reduce((sum, term) => sum + weight(term), 0) / Math.max(1, latinQuery.reduce((sum, term) => sum + weight(term), 0));
            queryCoverage = Math.max(queryCoverage, comparable);
        }
        const docCoverage = Math.max(coverage(item.title), coverage(item.triggers), coverage(item.terms));
        const lexical = queryCoverage * 0.55 + docCoverage * 0.35 + coverage(item.title) * 0.10;
        // Feedback is a small tie-breaker. It can never rescue absent task overlap.
        const success = Math.max(0, item.skill.feedback?.success ?? 0), failure = Math.max(0, item.skill.feedback?.failure ?? 0);
        const feedback = Math.min(0.025, Math.log1p(success) * 0.005) - Math.min(0.12, failure / Math.max(1, success + failure) * 0.12);
        item.score = matched.length ? Math.max(0, Math.min(1, lexical + feedback)) : 0;
        const anchors = matched.filter((term) => item.title.has(term) || item.triggers.has(term));
        if (item.score < minScore || !anchors.length) {
            reject(item.skill.id, "weak_task_match");
            continue;
        }
        item.reasons.push("task_terms_matched");
        if (item.constraints.uncertain)
            item.reasons.push(...item.constraints.reasons);
        // Chinese bigrams from one word are correlated; count shared technical
        // aliases or two English topic words, or a matched full Chinese title.
        const distinctAnchors = anchors.filter((term) => !/[\p{Script=Han}]/u.test(term));
        const namedChineseTopic = /[\p{Script=Han}]/u.test(item.skill.title ?? item.skill.name) &&
            normalizedText(positiveTask).includes(normalizedText(item.skill.title ?? item.skill.name));
        item.auto = item.score >= autoScore && (distinctAnchors.length >= 2 || namedChineseTopic) && !item.constraints.uncertain;
        if (item.auto)
            item.reasons.push("high_specificity_match");
        else if (item.score >= autoScore && distinctAnchors.length < 2 && !namedChineseTopic)
            item.reasons.push("insufficient_specific_anchors");
    }
    let ranked = index.filter((item) => item.reasons.length).sort((a, b) => b.score - a.score || (timestamp(b.skill) ?? 0) - (timestamp(a.skill) ?? 0) || a.skill.id.localeCompare(b.skill.id));
    const removed = new Set();
    for (let left = 0; left < ranked.length; left++) {
        const item = ranked[left];
        if (removed.has(item.skill.id))
            continue;
        const duplicates = [item.skill.id];
        for (let right = left + 1; right < ranked.length; right++) {
            const other = ranked[right];
            if (removed.has(other.skill.id))
                continue;
            const sameTopic = jaccard(item.title, other.title) >= 0.65 && jaccard(item.terms, other.terms) >= 0.75;
            const explicitConflict = item.skill.conflictGroup && item.skill.conflictGroup === other.skill.conflictGroup;
            if (item.skill.supersedes?.includes(other.skill.id)) {
                removed.add(other.skill.id);
                reject(other.skill.id, "superseded");
                continue;
            }
            if (other.skill.supersedes?.includes(item.skill.id)) {
                removed.add(item.skill.id);
                reject(item.skill.id, "superseded");
                break;
            }
            const duplicate = item.skill.sha256 === other.skill.sha256 || sameTopic && !!item.procedure && item.procedure === other.procedure;
            if (duplicate) {
                duplicates.push(other.skill.id);
                removed.add(other.skill.id);
                reject(other.skill.id, "duplicate_coverage");
                continue;
            }
            if (explicitConflict || sameTopic && !!item.procedure && !!other.procedure && item.procedure !== other.procedure) {
                item.auto = false;
                other.auto = false;
                item.reasons.push("conflicting_alternatives");
                other.reasons.push("conflicting_alternatives");
            }
            else if (sameTopic && Math.abs(item.score - other.score) < 0.08) {
                item.auto = false;
                other.auto = false;
                item.reasons.push("ambiguous_near_duplicate");
                other.reasons.push("ambiguous_near_duplicate");
            }
        }
        if (duplicates.length > 1)
            result.duplicateGroups.push(duplicates);
    }
    ranked = ranked.filter((item) => !removed.has(item.skill.id)).slice(0, candidateLimit);
    let loaded = 0;
    result.candidates = ranked.map((item) => {
        const autoLoad = item.auto && loaded < autoLoadLimit;
        if (autoLoad)
            loaded++;
        const reasonCodes = [...new Set(item.reasons)];
        if (item.auto && !autoLoad)
            reasonCodes.push("auto_load_limit");
        return { id: item.skill.id, title: (item.skill.title ?? item.skill.name).slice(0, 200), description: item.skill.description.slice(0, 800),
            score: Math.round(item.score * 10_000) / 10_000, match: item.auto ? "high" : "possible", autoLoad, reasonCodes,
            sha256: item.skill.sha256, version: item.skill.version };
    });
    result.autoLoadIds = result.candidates.filter((item) => item.autoLoad).map((item) => item.id);
    return result;
}
//# sourceMappingURL=retrieval.js.map