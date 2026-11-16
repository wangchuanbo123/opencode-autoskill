import os from "node:os";
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = String.raw `\b(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|account[_-]?key|signing[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|passphrase|pass|pwd|client[_-]?secret|private[_-]?key|secret[_-]?key|secret|authorization|(?:set[_-]?)?cookie|connection[_-]?string|database[_-]?url|database[_-]?password)`;
const ASSIGNMENT = `${SENSITIVE_KEY}["']?\\s*[:=]\\s*`;
const SENSITIVE_FIELD = new RegExp(`^${SENSITIVE_KEY}$`, "i");
function placeholder(value) {
    const trimmed = value.trim().replace(/^(?:Bearer|Basic)\s+/i, "");
    return !trimmed || /^(?:\[REDACTED\]|<REDACTED>|<[a-z0-9_-]+>|\$(?:env:)?[a-z_][a-z0-9_]*|\$\{[a-z_][a-z0-9_]*\}|%[a-z_][a-z0-9_]*%)$/i.test(trimmed)
        || /^process\.env(?:\.[a-z_][a-z0-9_]*|\[["'][a-z_][a-z0-9_]*["']\])$/i.test(trimmed);
}
function redactSecrets(text) {
    let result = text
        .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, REDACTED)
        .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, REDACTED)
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
        .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, REDACTED)
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, REDACTED)
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
    // Shell parameters are not assignments. Keep safe environment references usable.
    const cliValue = String.raw `(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s;&|]+)`;
    const cli = new RegExp(`((?:^|\\s)(?:--(?:password|passwd|passphrase|token|api-key|access-token|secret|client-secret|user)|-u)(?:=|\\s+))(${cliValue})`, "gi");
    result = result.replace(cli, (match, prefix, value) => {
        const unquoted = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
        return placeholder(unquoted) ? match : `${prefix}${REDACTED}`;
    });
    // Quoted values may contain spaces or escaped quotes; replacing only the first
    // whitespace-delimited token would leave the rest of a password visible.
    for (const quote of ['"', "'"]) {
        const content = quote === '"' ? String.raw `(?:\\[\s\S]|[^"\\])*` : String.raw `(?:\\[\s\S]|[^'\\])*`;
        const pattern = new RegExp(`(${ASSIGNMENT})(${quote})(${content})${quote}`, "gi");
        result = result.replace(pattern, (match, prefix, delimiter, value) => placeholder(value) ? match : `${prefix}${delimiter}${REDACTED}${delimiter}`);
    }
    const unquoted = new RegExp(`(${ASSIGNMENT})(process\\.env\\[["'][a-z_][a-z0-9_]*["']\\]|\\$\\{[^}\\r\\n]*\\}|\\[[^\\]\\r\\n]*\\]|<[^>\\r\\n]*>|[^\\s"'\x60,;}&\\]#]+)`, "gi");
    result = result.replace(unquoted, (match, prefix, value) => placeholder(value) ? match : `${prefix}${REDACTED}`);
    result = result.replace(/(\b(?:cookie|set-cookie|authorization)\s*:\s*)([^\r\n]+)/gi, (match, prefix, value) => placeholder(value) ? match : `${prefix}${REDACTED}`);
    return result;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function redactPath(text, value, replacement) {
    if (!value || value === "/" || /^[a-z]:[\\/]*$/i.test(value))
        return text;
    const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
    const normalized = value.replace(/[\\/]+$/, "");
    const parts = windows ? normalized.split(/[\\/]+/).filter(Boolean) : normalized.split("/");
    const separator = windows ? String.raw `(?:\\{1,2}|/)` : "/";
    const prefix = windows && /^\\\\/.test(normalized) ? String.raw `(?:\\{2,4}|//)` : "";
    const pathPattern = prefix + parts.map(escapeRegex).join(separator);
    // Match full path segments. A project named "repo" must not hide "repo-other".
    const start = String.raw `(?<![a-z0-9_./\\-])`;
    const end = String.raw `(?=$|[\\/\s"'\x60<>()[\]{},;:!?]|\.(?=\s|$))`;
    return text.replace(new RegExp(`${start}${pathPattern}${end}`, windows ? "gi" : "g"), replacement);
}
function redactText(text, root) {
    let result = redactSecrets(text);
    result = redactPath(result, root, "<PROJECT>");
    return redactPath(result, os.homedir(), "<HOME>");
}
function structured(text) {
    if (!/^\s*[\[{]/.test(text))
        return undefined;
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function sensitiveValue(key, value) {
    return SENSITIVE_FIELD.test(key) && value !== null && value !== undefined && typeof value !== "boolean" &&
        (typeof value !== "string" || !placeholder(value));
}
/** Redact decoded JSON leaves before serialization, including entire credential fields. */
export function redactValue(value, root = "") {
    const seen = new WeakSet();
    function visit(item, key) {
        if (sensitiveValue(key, item))
            return REDACTED;
        if (typeof item === "string")
            return redact(item, root);
        if (!item || typeof item !== "object")
            return item;
        if (seen.has(item))
            return "[Circular]";
        seen.add(item);
        const result = Array.isArray(item)
            ? item.map((child) => visit(child, ""))
            : Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
        seen.delete(item);
        return result;
    }
    return visit(value, "");
}
/** Detect secrets on decoded values, so JSON escaping cannot hide or corrupt them. */
export function containsSecretValue(value) {
    const seen = new WeakSet();
    function visit(item, key) {
        if (sensitiveValue(key, item))
            return true;
        if (typeof item === "string")
            return containsSecret(item);
        if (!item || typeof item !== "object" || seen.has(item))
            return false;
        seen.add(item);
        return Array.isArray(item) ? item.some((child) => visit(child, "")) : Object.entries(item).some(([name, child]) => visit(child, name));
    }
    return visit(value, "");
}
export function redact(text, root = "") {
    const parsed = structured(text);
    if (parsed) {
        const result = redactValue(parsed, root);
        return JSON.stringify(parsed) === JSON.stringify(result) ? text : JSON.stringify(result);
    }
    return redactText(text, root);
}
export function containsSecret(text) {
    const parsed = structured(text);
    return parsed ? containsSecretValue(parsed) : redactSecrets(text) !== text;
}
export function truncate(text, max) {
    const limit = Math.max(0, Math.floor(max));
    if (text.length <= limit)
        return text;
    const marker = "\n[truncated]\n";
    if (limit <= marker.length)
        return text.slice(0, limit);
    const budget = limit - marker.length;
    const beginning = Math.ceil(budget * 0.7);
    const ending = budget - beginning;
    return `${text.slice(0, beginning)}${marker}${ending ? text.slice(-ending) : ""}`;
}
const DEFAULT_EXCLUDED_FILES = [".env", ".env.*", "*.pem", "*.key", "credentials", "credentials.*", "auth.json", "auth.yaml", "auth.yml", ".netrc", ".npmrc", "id_rsa", "id_ed25519"];
function globMatches(text, glob) {
    const normalized = text.replaceAll("\\", "/");
    const source = glob.replaceAll("\\", "/");
    let pattern = "";
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === "*" && source[index + 1] === "*") {
            index++;
            if (source[index + 1] === "/") {
                index++;
                pattern += "(?:.*/)?";
            }
            else
                pattern += ".*";
        }
        else if (character === "*")
            pattern += "[^/\\s\"']*";
        else if (character === "?")
            pattern += "[^/\\s\"']";
        else
            pattern += escapeRegex(character);
    }
    return new RegExp(`(?:^|[\\s/"'=])${pattern}(?=$|[\\s/"';,])`, "i").test(normalized);
}
/** Drop high-sensitivity operations entirely; redaction alone is not an access policy. */
export function sanitizeTool(tool, options) {
    if ((options.excludeTools ?? []).some((name) => name === tool.name || globMatches(tool.name, name)))
        return undefined;
    const input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? null);
    if ([...DEFAULT_EXCLUDED_FILES, ...(options.excludeFiles ?? [])].some((glob) => globMatches(input, glob)))
        return undefined;
    if (containsSecret(input))
        return undefined;
    for (const source of options.sensitivePatterns ?? []) {
        // User rules are literal fragments, not executable regular expressions.
        if (source.length < 3 || source.length > 500)
            throw new Error("Sensitive pattern must contain 3–500 literal characters.");
        if (input.toLowerCase().includes(source.toLowerCase()) || tool.output.toLowerCase().includes(source.toLowerCase()))
            return undefined;
    }
    return { ...tool, input: redactValue(tool.input, options.root), output: redact(tool.output, options.root) };
}
//# sourceMappingURL=safety.js.map