import { createHash } from "node:crypto";
import { redact, sanitizeTool, truncate } from "./safety.js";
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Keep native IDs for host lookups; use this identity only in shared state. */
export function scopedSessionId(sessionId, hostId, workspaceId) {
    return hostId ? `${hostId}:${digest([workspaceId ?? "", sessionId])}` : sessionId;
}
export function completedForReview(snapshot) {
    return snapshot.terminal === "success" || snapshot.terminal === "unknown" && snapshot.executionCompleted === true;
}
export function taskMessages(messages) {
    return messages.map((message) => ({ ...message, tools: message.tools.filter((tool) => !tool.name.startsWith("autoskill_")) }))
        .filter((message) => message.text.trim() || message.tools.length);
}
export function matchesSession(sessionId, excluded) {
    return excluded.some((value) => value === sessionId || value.endsWith("*") && sessionId.startsWith(value.slice(0, -1)));
}
/** Custom privacy patterns are literal, case-insensitive values (never regexes). */
function redactSensitive(text, patterns) {
    let output = text, matched = false;
    for (const pattern of patterns) {
        if (!pattern)
            continue;
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const expression = new RegExp(escaped, "gi");
        if (expression.test(output))
            matched = true;
        output = output.replace(expression, "[redacted-sensitive]");
    }
    return { text: output, matched };
}
/** Preserve every allowed tool in a bounded packet, with final checks shared between packets. */
export function collectTasks(snapshot, options, root) {
    const segments = [];
    for (const message of taskMessages(snapshot.messages)) {
        if (message.role === "user") {
            const previous = segments.at(-1);
            const continuation = /^(?:继续|接着|再试|重试|完成剩余|continue\b|retry\b|try again\b)/i.test(message.text.trim());
            if (!previous || !continuation || !previous.some((item) => item.tools.some((tool) => tool.status !== "completed")))
                segments.push([]);
            else
                for (const item of previous)
                    for (const tool of item.tools)
                        if (tool.status === "pending") {
                            tool.status = "error";
                            tool.output = "Previous interrupted operation did not complete.";
                        }
        }
        segments.at(-1)?.push(structuredClone(message));
    }
    const packets = [];
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const anchor = segment.find((message) => message.role === "user");
        const taskId = snapshot.hostId ? digest([snapshot.hostId, snapshot.workspaceId ?? root, snapshot.sessionId, snapshot.turnId ?? "", anchor.id, snapshot.revision ?? ""]) : digest([snapshot.sessionId, anchor.id]);
        const rawTools = segment.flatMap((message) => message.tools);
        const boundary = snapshot.taskBoundaries?.find((item) => item.messageId === anchor.id);
        const terminal = boundary?.terminal ?? (index === segments.length - 1 ? snapshot.terminal : snapshot.hostId ? "unknown" : "success");
        const executionCompleted = boundary?.executionCompleted ?? (index === segments.length - 1 ? snapshot.executionCompleted : undefined);
        const pending = rawTools.some((tool) => tool.status === "pending");
        const sensitiveText = segment.reduce((found, message) => {
            const text = redactSensitive(message.text, options.sensitivePatterns);
            const error = redactSensitive(message.error ?? "", options.sensitivePatterns);
            found.matched ||= text.matched || error.matched;
            found.messages.push({ message, text: text.text, error: error.text });
            return found;
        }, { matched: false, messages: [] });
        const allowed = new Map();
        for (const tool of rawTools) {
            const sanitized = sanitizeTool(tool, { root, excludeTools: options.excludeTools, excludeFiles: options.excludeFiles, sensitivePatterns: options.sensitivePatterns });
            if (sanitized)
                allowed.set(tool.id, { ...sanitized, output: truncate(sanitized.output, options.maxToolOutputChars) });
        }
        const sanitizedMessages = sensitiveText.messages.map(({ message, text, error }) => ({ ...message, text: truncate(redact(text, root), 5_000),
            error: message.error ? truncate(redact(error, root), 1_000) : undefined,
            tools: message.tools.flatMap((tool) => allowed.has(tool.id) ? [allowed.get(tool.id)] : []) }));
        const tools = [...allowed.values()];
        const finalChecks = tools.filter((tool) => tool.status === "completed").slice(-2);
        const chunks = [];
        for (let offset = 0; offset < tools.length; offset += 48)
            chunks.push(tools.slice(offset, offset + 48));
        if (!chunks.length)
            chunks.push([]);
        for (let part = 0; part < chunks.length; part++) {
            const chunk = chunks[part];
            const ids = new Set([...chunk, ...finalChecks].map((tool) => tool.id));
            const messages = sanitizedMessages.map((message) => ({ ...message, tools: message.tools.filter((tool) => ids.has(tool.id)) }));
            const packetSnapshot = { ...snapshot, terminal, executionCompleted, messages };
            const completed = completedForReview(packetSnapshot);
            const eligible = completed && !pending && !sensitiveText.matched && segment.some((message) => message.role === "assistant");
            const reasonCode = sensitiveText.matched ? "sensitive_content" : pending ? "unfinished_tools" : !completed ? "execution_not_successful" : !segment.some((message) => message.role === "assistant") ? "no_assistant_evidence" : undefined;
            // Include terminal outcome and eligibility so a later successful retry
            // cannot be hidden by a failed/unfinished packet tombstone.
            const fingerprint = snapshot.hostId ? digest([taskId, part, terminal, executionCompleted, eligible, reasonCode, messages]) : digest([taskId, part, terminal, eligible, reasonCode, messages]);
            packets.push({ id: digest([taskId, part, fingerprint]), taskId, anchorId: anchor.id, fingerprint, snapshot: packetSnapshot,
                coverage: chunk.map((tool) => tool.id), eligible, reasonCode });
        }
    }
    return packets;
}
export { assessComplexity, COMPLEXITY_POLICY_VERSION } from "./complexity.js";
//# sourceMappingURL=tasks.js.map