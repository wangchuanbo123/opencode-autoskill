import type { ModelRef } from "../types.js";

export interface ReviewerConfig {
  type: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  maxOutputTokens?: number;
}

export function reviewerStatus(config?: ReviewerConfig): { available: boolean; reasonCode?: string } {
  if (!config) return { available: false, reasonCode: "model_backend_unconfigured" };
  validateReviewer(config);
  if (config.apiKeyEnv && !process.env[config.apiKeyEnv]) return { available: false, reasonCode: "model_credential_missing" };
  return { available: true };
}

export function validateReviewer(config: ReviewerConfig): URL {
  if (config.type !== "openai-compatible" || typeof config.model !== "string" || !config.model.trim() || config.model.length > 200) throw new Error("Invalid AutoSkill reviewer model.");
  const url = new URL(config.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local) || url.username || url.password || url.search || url.hash) throw new Error("Reviewer URL must be HTTPS, or loopback HTTP, without embedded credentials or query parameters.");
  if (config.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error("Reviewer credentials must name an environment variable.");
  if (!local && !config.apiKeyEnv) throw new Error("A remote reviewer requires apiKeyEnv.");
  if (config.maxOutputTokens !== undefined && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 256 || config.maxOutputTokens > 32_768)) throw new Error("Invalid reviewer output budget.");
  return url;
}

/** An explicit provider configuration never reads the host's private login files. */
export async function generateReview(config: ReviewerConfig | undefined, input: { prompt: string; signal: AbortSignal; model?: ModelRef }): Promise<string> {
  const status = reviewerStatus(config);
  if (!status.available || !config) throw new Error(status.reasonCode);
  const url = validateReviewer(config);
  url.pathname = url.pathname.replace(/\/$/, "") + "/chat/completions";
  const credential = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  const response = await fetch(url, { method: "POST", redirect: "error", signal: input.signal,
    headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: input.prompt }],
      response_format: { type: "json_object" }, max_tokens: config.maxOutputTokens ?? 8_192, temperature: 0 }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Reviewer HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Reviewer returned an empty response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 1_048_576) throw new Error("Reviewer response exceeded the output budget.");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { choices?: { message?: { content?: unknown } }[] };
  const text = result.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Reviewer did not return text.");
  return text;
}
