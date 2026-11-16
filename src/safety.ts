import os from "node:os";
import type { ToolRecord } from "./types.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = String.raw`\b(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|account[_-]?key|signing[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|passphrase|pass|pwd|client[_-]?secret|private[_-]?key|secret[_-]?key|secret|authorization|(?:set[_-]?)?cookie|connection[_-]?string|database[_-]?url|database[_-]?password)`;
const ASSIGNMENT = `${SENSITIVE_KEY}["']?\\s*[:=]\\s*`;
const SENSITIVE_FIELD = new RegExp(`^${SENSITIVE_KEY}$`, "i");

function placeholder(value: string): boolean {
  const trimmed = value.trim().replace(/^(?:Bearer|Basic)\s+/i, "");
  return !trimmed || /^(?:\[REDACTED\]|<REDACTED>|<[a-z0-9_-]+>|\$(?:env:)?[a-z_][a-z0-9_]*|\$\{[a-z_][a-z0-9_]*\}|%[a-z_][a-z0-9_]*%)$/i.test(trimmed)
    || /^process\.env(?:\.[a-z_][a-z0-9_]*|\[["'][a-z_][a-z0-9_]*["']\])$/i.test(trimmed);
}

function redactSecrets(text: string): string {
  let result = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, REDACTED)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);

  // Shell parameters are not assignments. Keep safe environment references usable.
  const cliValue = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s;&|]+)`;
  const cli = new RegExp(`((?:^|\\s)(?:--(?:password|passwd|passphrase|token|api-key|access-token|secret|client-secret|user)|-u)(?:=|\\s+))(${cliValue})`, "gi");
  result = result.replace(cli, (match, prefix: string, value: string) => {
    const unquoted = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
    return placeholder(unquoted) ? match : `${prefix}${REDACTED}`;
  });

  // Quoted values may contain spaces or escaped quotes; replacing only the first
  // whitespace-delimited token would leave the rest of a password visible.
  for (const quote of ['"', "'"]) {
    const content = quote === '"' ? String.raw`(?:\\[\s\S]|[^"\\])*` : String.raw`(?:\\[\s\S]|[^'\\])*`;
    const pattern = new RegExp(`(${ASSIGNMENT})(${quote})(${content})${quote}`, "gi");
    result = result.replace(pattern, (match, prefix: string, delimiter: string, value: string) =>
      placeholder(value) ? match : `${prefix}${delimiter}${REDACTED}${delimiter}`);
  }
  const unquoted = new RegExp(`(${ASSIGNMENT})(process\\.env\\[["'][a-z_][a-z0-9_]*["']\\]|\\$\\{[^}\\r\\n]*\\}|\\[[^\\]\\r\\n]*\\]|<[^>\\r\\n]*>|[^\\s"'\x60,;}&\\]#]+)`, "gi");
  result = result.replace(unquoted, (match, prefix: string, value: string) => placeholder(value) ? match : `${prefix}${REDACTED}`);
  result = result.replace(/(\b(?:cookie|set-cookie|authorization)\s*:\s*)([^\r\n]+)/gi,
    (match, prefix: string, value: string) => placeholder(value) ? match : `${prefix}${REDACTED}`);
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactPath(text: string, value: string, replacement: string): string {
  if (!value || value === "/" || /^[a-z]:[\\/]*$/i.test(value)) return text;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = windows ? normalized.split(/[\\/]+/).filter(Boolean) : normalized.split("/");
  const separator = windows ? String.raw`(?:\\{1,2}|/)` : "/";
  const prefix = windows && /^\\\\/.test(normalized) ? String.raw`(?:\\{2,4}|//)` : "";
  const pathPattern = prefix + parts.map(escapeRegex).join(separator);
  // Match full path segments. A project named "repo" must not hide "repo-other".
  const start = String.raw`(?<![a-z0-9_./\\-])`;
  const end = String.raw`(?=$|[\\/\s"'\x60<>()[\]{},;:!?]|\.(?=\s|$))`;
  return text.replace(new RegExp(`${start}${pathPattern}${end}`, windows ? "gi" : "g"), replacement);
}

function redactText(text: string, root: string): string {
  let result = redactSecrets(text);
  result = redactPath(result, root, "<PROJECT>");
  return redactPath(result, os.homedir(), "<HOME>");
}

function structured(text: string): object | undefined {
  if (!/^\s*[\[{]/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch { return undefined; }
}

function sensitiveValue(key: string, value: unknown): boolean {
  return SENSITIVE_FIELD.test(key) && value !== null && value !== undefined && typeof value !== "boolean" &&
    (typeof value !== "string" || !placeholder(value));
}

/** Redact decoded JSON leaves before serialization, including entire credential fields. */
export function redactValue<T>(value: T, root = ""): T {
  const seen = new WeakSet<object>();
  function visit(item: unknown, key: string): unknown {
    if (sensitiveValue(key, item)) return REDACTED;
    if (typeof item === "string") return redact(item, root);
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map((child) => visit(child, ""))
      : Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
    seen.delete(item);
    return result;
  }
  return visit(value, "") as T;
}

/** Detect secrets on decoded values, so JSON escaping cannot hide or corrupt them. */
export function containsSecretValue(value: unknown): boolean {
  const seen = new WeakSet<object>();
  function visit(item: unknown, key: string): boolean {
    if (sensitiveValue(key, item)) return true;
    if (typeof item === "string") return containsSecret(item);
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    return Array.isArray(item) ? item.some((child) => visit(child, "")) : Object.entries(item).some(([name, child]) => visit(child, name));
  }
  return visit(value, "");
}

export function redact(text: string, root = ""): string {
  const parsed = structured(text);
  if (parsed) {
    const result = redactValue(parsed, root);
    return JSON.stringify(parsed) === JSON.stringify(result) ? text : JSON.stringify(result);
  }
  return redactText(text, root);
}

export function containsSecret(text: string): boolean {
  const parsed = structured(text);
  return parsed ? containsSecretValue(parsed) : redactSecrets(text) !== text;
}

export function truncate(text: string, max: number): string {
  const limit = Math.max(0, Math.floor(max));
  if (text.length <= limit) return text;
  const marker = "\n[truncated]\n";
  if (limit <= marker.length) return text.slice(0, limit);
  const budget = limit - marker.length;
  const beginning = Math.ceil(budget * 0.7);
  const ending = budget - beginning;
  return `${text.slice(0, beginning)}${marker}${ending ? text.slice(-ending) : ""}`;
}

export interface PrivacyFilterOptions {
  root: string;
  excludeTools?: string[];
  excludeFiles?: string[];
  sensitivePatterns?: string[];
}

const DEFAULT_EXCLUDED_FILES = [".env", ".env.*", "*.pem", "*.key", "credentials", "credentials.*", "auth.json", "auth.yaml", "auth.yml", ".netrc", ".npmrc", "id_rsa", "id_ed25519"];

function globMatches(text: string, glob: string): boolean {
  const normalized = text.replaceAll("\\", "/");
  const source = glob.replaceAll("\\", "/");
  let pattern = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "*" && source[index + 1] === "*") {
      index++;
      if (source[index + 1] === "/") { index++; pattern += "(?:.*/)?"; }
      else pattern += ".*";
    } else if (character === "*") pattern += "[^/\\s\"']*";
    else if (character === "?") pattern += "[^/\\s\"']";
    else pattern += escapeRegex(character);
  }
  return new RegExp(`(?:^|[\\s/"'=])${pattern}(?=$|[\\s/"';,])`, "i").test(normalized);
}

/** Drop high-sensitivity operations entirely; redaction alone is not an access policy. */
export function sanitizeTool(tool: ToolRecord, options: PrivacyFilterOptions): ToolRecord | undefined {
  if ((options.excludeTools ?? []).some((name) => name === tool.name || globMatches(tool.name, name))) return undefined;
  const input = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? null);
  if ([...DEFAULT_EXCLUDED_FILES, ...(options.excludeFiles ?? [])].some((glob) => globMatches(input, glob))) return undefined;
  if (containsSecret(input)) return undefined;
  for (const source of options.sensitivePatterns ?? []) {
    // User rules are literal fragments, not executable regular expressions.
    if (source.length < 3 || source.length > 500) throw new Error("Sensitive pattern must contain 3–500 literal characters.");
    if (input.toLowerCase().includes(source.toLowerCase()) || tool.output.toLowerCase().includes(source.toLowerCase())) return undefined;
  }
  return { ...tool, input: redactValue(tool.input, options.root), output: redact(tool.output, options.root) };
}
