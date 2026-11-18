import { createHash } from "node:crypto";
import type { AutoSkillOptions, TaskSnapshot, ToolRecord } from "./types.js";

export const COMPLEXITY_POLICY_VERSION = "evidence-v1";

export interface ComplexityDimension {
  present: boolean;
  points: number;
  toolCallIds: string[];
}

/** A routing heuristic for semantic review, never a proof of complexity or reuse. */
export interface ComplexityAssessment {
  version: typeof COMPLEXITY_POLICY_VERSION;
  eligible: boolean;
  score: number;
  threshold: number;
  logicalSteps: number;
  uniqueOperations: number;
  repeatedOperations: number;
  successfulEvidenceCount: number;
  dimensions: Record<"dependencyChain" | "diagnosticResolution" | "crossResourceCoordination" | "investigation" | "decisionEvidence" | "verification" | "operationDiversity", ComplexityDimension>;
  signals: string[];
  reasonCodes: string[];
}

interface Observation {
  tool: ToolRecord;
  index: number;
  key: string;
  input: string;
  output: string;
  resources: Set<string>;
  inspect: boolean;
  transform: boolean;
  verify: boolean;
  decision: boolean;
  codeDependency: boolean;
}

const inspectAction = /(?:^|[^a-z])(?:read|inspect|search|query|select|explain|diagnos\w*|analy[sz]\w*|compare|reproduce|trace|diff|grep|rg|cat|get-content)(?:[^a-z]|$)|读取|检查|查询|追踪|对比|复现/i;
const transformAction = /(?:^|[^a-z])(?:write|edit|apply_patch|patch|update|insert|migrat\w*|repair|convert|transform|set-content|add-content)(?:[^a-z]|$)|修改|迁移|修正|转换|写入/i;
const verifyAction = /(?:^|[^a-z])(?:test\w*|verif\w*|validat\w*|check\w*|assert\w*|reconcil\w*|lint|pytest|vitest|jest)(?:[^a-z]|$)|核验|校验|验证|测试|核对/i;
const verifiedOutput = /(?:\bpassed\b|\bverified\b|\bvalidated\b|\bconsistent\b|\bmatched\b|\bmatches\b|\bassertions?\b.{0,30}\bok\b|\b0 (?:errors|failures)\b|验证通过|测试通过|验证成功|检查通过|核对一致|结果一致)/i;
const decisionOutput = /(?:root cause|caused by|because|due to|depends? (?:on|only)|dependency:|omitt?\w*|mismatch|collision|violates?|rather than|compared?[^\n]{0,160}(?:versus|\bvs\b|instead of)|根因|原因.{0,20}(?:是|为)|由于|导致|依赖|缺少|不一致|相比|而非)/i;
const coordinationOutput = /(?:producer|consumer|contract|schema|protocol|serializ\w*|deserializ\w*|compatib\w*|dependency|migration|生产者|消费者|契约|协议|兼容|依赖|迁移)/i;
const mechanicalError = /(?:command not found|not recognized as (?:an? )?(?:internal|command)|unknown (?:option|argument)|unrecognized (?:option|argument)|is not recognized|拼写|找不到命令|无法识别.{0,20}(?:命令|参数))/i;
const genericTerms = new Set("command input output result results observed independent regression test tests passed verified verification check checks diagnostic fixture fixtures shell node python npm npx tool tools status completed source root cause identified script scripts file files path paths read inspect run execute code const await return content error errors updated update because only from with that this before after includes include actual expected all the and for use into then".split(" "));

function textInput(input: unknown): string {
  let value = input;
  if (value && typeof value === "object") {
    if ("command" in value && typeof value.command === "string") value = value.command;
    else if ("cmd" in value && typeof value.cmd === "string") value = value.cmd;
  }
  return (typeof value === "string" ? value : JSON.stringify(value ?? null)).slice(0, 80_000);
}

function transformation(tool: ToolRecord, input: string, code: boolean): boolean {
  if (tool.category === "write" || transformAction.test(tool.nativeName ?? tool.name)) return true;
  if (code) return /\b(?:tools|functions|mcp)\.[\w$]*(?:write|edit|patch|migrat|repair|convert|transform)[\w$]*\s*\(|\bawait\s+[\w$]*(?:write|edit|patch|migrat|repair|convert|transform)[\w$]*\s*\(/i.test(input);
  const command = textInput(tool.input);
  // A test name such as "migration-lock" is a subject, not a mutation. Only
  // executable mutation actions/scripts qualify when the outer tool is generic.
  return /(?:^|[;&|\n]\s*)(?:\s*(?:git\s+apply|sed\s+-i|perl\s+-[a-z]*i|(?:set|add)-content|(?:cp|mv|copy|move)\s))|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:migrate|migration|db:migrate)\b|(?:^|[\s/\\])(?:migrate|repair|convert|transform)[\w.-]*\.(?:[cm]?[jt]s|py|sh|ps1)\b/i.test(command);
}

function substantive(text: string): boolean {
  const value = text.replace(/\[(?:redacted|truncated)[^\]]*\]|<PROJECT>|<HOME>|Exit code:\s*-?\d+/gi, "").trim();
  return value.length >= (/[\p{Script=Han}]/u.test(value) ? 4 : 8);
}

function terms(text: string): Set<string> {
  const normalized = text.toLowerCase().normalize("NFKC");
  const values = (normalized.match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
    .flatMap((word) => [word, ...word.split(/[-_]/)])
    .filter((word) => word.length >= 4 && !genericTerms.has(word));
  for (const word of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < word.length - 1; index++) {
      const pair = word.slice(index, index + 2);
      if (!/通过|验证|测试|检查|结果|独立|已经|完成/.test(pair)) values.push(pair);
    }
  }
  return new Set(values);
}

function related(left: Observation, right: Observation): boolean {
  if ([...left.resources].some((resource) => right.resources.has(resource))) return true;
  const subject = terms(`${left.input} ${left.output}`);
  return [...terms(`${right.input} ${right.output}`)].some((word) => subject.has(word));
}

function resources(text: string): Set<string> {
  const normalized = text.replaceAll("\\", "/").toLowerCase();
  return new Set(normalized.match(/(?:[a-z0-9_@.-]+\/)*[a-z0-9_@-]+\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|sql|py|go|rs|java|cs|md|csv|xml|proto|graphql|sh|ps1)\b/g) ?? []);
}

function logicalSteps(tool: ToolRecord): number {
  if (!/^(?:execute|codemode)$/i.test(tool.name)) return 1;
  const input = textInput(tool.input);
  return Math.min(50, Math.max(1, input.match(/\b(?:tools|functions|mcp)\.[a-zA-Z_$][\w$]*\s*\(|\bawait\s+[a-zA-Z_$][\w$]*\s*\(/g)?.length ?? 0));
}

function codeDataDependency(input: string): boolean {
  // Keep positions but remove literal/comment text: mentioning a variable in a
  // patch string, return value, or log does not connect it to a transformation.
  const code = input.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (value) => " ".repeat(value.length));
  const close = (open: number): number => {
    const end = code[open] === "(" ? ")" : "}";
    let depth = 0;
    for (let index = open; index < code.length; index++) {
      if (code[index] === code[open]) depth++;
      if (code[index] === end && --depth === 0) return index;
    }
    return -1;
  };
  const results = [...code.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*await\s+(?:[\w$]+\.)*[\w$]+\s*\(/g)]
    .map((match) => ({ name: match[1]!, index: match.index! }));
  const changes = [...code.matchAll(/\b(?:tools|functions|mcp)\.[\w$]*(?:write|edit|patch|migrat|repair|convert|transform)[\w$]*\s*\(|\bawait\s+[\w$]*(?:write|edit|patch|migrat|repair|convert|transform)[\w$]*\s*\(/gi)]
    .map((match) => ({ index: match.index!, open: match.index! + match[0].lastIndexOf("(") }))
    .map((call) => ({ ...call, end: close(call.open) })).filter((call) => call.end >= 0);
  for (const result of results) {
    const used = new RegExp(`\\b${result.name.replace(/[$]/g, "\\$")}\\b`);
    for (const change of changes.filter((call) => call.index > result.index)) {
      if (used.test(code.slice(change.open + 1, change.end))) return true;
      for (const condition of code.matchAll(/\bif\s*\(/g)) {
        const start = condition.index!, open = start + condition[0].lastIndexOf("("), end = close(open);
        if (start <= result.index || end < 0 || end >= change.index || !used.test(code.slice(open + 1, end))) continue;
        const bodyStart = end + 1 + (code.slice(end + 1).match(/^\s*/)?.[0].length ?? 0);
        const bodyEnd = code[bodyStart] === "{" ? close(bodyStart) : code.indexOf(";", bodyStart);
        if (bodyEnd >= change.end && bodyStart <= change.index) return true;
      }
    }
  }
  return false;
}

function observe(tool: ToolRecord, index: number): Observation {
  const input = textInput(tool.input), output = tool.output.slice(0, 30_000);
  const action = `${tool.nativeName ?? tool.name} ${input}`;
  const code = /^(?:execute|codemode)$/i.test(tool.name);
  const decision = tool.status === "completed" && substantive(output) && decisionOutput.test(output);
  const transform = transformation(tool, input, code);
  // A logged success string from echo/printf cannot turn an operation into a check.
  const echoed = /\b(?:echo|printf|write-output)\b[^\n]{0,160}(?:passed|verified|validated|测试通过|验证通过)/i.test(input);
  const verify = tool.status === "completed" && substantive(output) && !echoed &&
    (verifyAction.test(action) || tool.category === "verify") && verifiedOutput.test(output) && (!transform || code);
  const inspect = tool.category === "read" || tool.category === "search" || inspectAction.test(action) || decision && !transform && !verify;
  const sourceCode = tool.input && typeof tool.input === "object" && "code" in tool.input ? String(tool.input.code) : input;
  const codeDependency = code && inspect && transform && codeDataDependency(sourceCode);
  return { tool, index, input, output, key: createHash("sha256").update(`${tool.name.toLowerCase()}\0${input.replace(/\s+/g, " ").trim()}`).digest("hex"),
    resources: resources(`${input} ${output}`), inspect, transform, verify, decision, codeDependency };
}

export function assessComplexity(snapshot: TaskSnapshot, options: AutoSkillOptions): ComplexityAssessment {
  const raw = snapshot.messages.flatMap((message) => message.tools).filter((tool) => !tool.name.startsWith("autoskill_"));
  const observations = raw.map(observe);
  const unique = new Map<string, Observation>();
  for (const observation of observations) {
    const previous = unique.get(observation.key);
    // Repeated reads/retries count as one operation. Keep the latest successful
    // observation, while the separate raw error sequence remains available below.
    if (!previous || observation.tool.status === "completed" || previous.tool.status !== "completed") unique.set(observation.key, observation);
  }
  const operations = [...unique.values()].sort((left, right) => left.index - right.index);
  const successful = operations.filter((item) => item.tool.status === "completed" && substantive(item.output));
  const checks = successful.filter((item) => item.verify);
  const independentCheck = (operation: Observation): Observation | undefined => checks.find((check) => check.tool.id !== operation.tool.id && check.index > operation.index && related(operation, check));
  const decisions = successful.filter((item) => item.decision);
  const inspections = successful.filter((item) => item.inspect && !item.verify);
  const changes = successful.filter((item) => item.transform && !item.verify);

  const chains: Observation[] = [];
  for (const change of changes) {
    const inspection = inspections.find((item) => item.index < change.index && related(item, change) || item.tool.id === change.tool.id && item.codeDependency);
    const check = independentCheck(change);
    if (inspection && check) chains.push(inspection, change, check);
  }
  const recoveries: Observation[] = [];
  for (const failure of observations.filter((item) => item.tool.status === "error" && !mechanicalError.test(item.output))) {
    const diagnosis = decisions.find((item) => item.index > failure.index && item.inspect && related(failure, item));
    if (!diagnosis) continue;
    const change = changes.find((item) => item.index >= diagnosis.index && item.key !== failure.key && related(diagnosis, item));
    const check = change && independentCheck(change);
    if (change && check) recoveries.push(failure, diagnosis, change, check);
  }
  const investigations: Observation[] = [];
  if (!changes.length) for (const inspection of inspections.filter((item) => item.decision)) {
    const check = independentCheck(inspection);
    if (check) investigations.push(inspection, check);
  }
  const changedResources = new Set(changes.flatMap((item) => [...item.resources]));
  const coordination = inspections.filter((item) => coordinationOutput.test(item.output) && [...item.resources].filter((resource) => changedResources.has(resource)).length >= 2);
  const coordinated = changedResources.size >= 2 && coordination.some((item) => independentCheck(item)) && chains.length > 0;
  const dimension = (items: Observation[], points: number): ComplexityDimension => ({ present: items.length > 0, points: items.length ? points : 0, toolCallIds: [...new Set(items.map((item) => item.tool.id))] });
  const diversity = new Set(successful.flatMap((item) => [item.inspect ? "inspect" : "", item.transform ? "transform" : "", item.verify ? "verify" : ""].filter(Boolean))).size >= 2;
  const dimensions: ComplexityAssessment["dimensions"] = {
    dependencyChain: dimension(chains, 5), diagnosticResolution: dimension(recoveries, 6),
    crossResourceCoordination: dimension(coordinated ? coordination : [], 4), investigation: dimension(investigations, 5),
    decisionEvidence: dimension(decisions, 3), verification: dimension(checks, 2), operationDiversity: dimension(diversity ? successful : [], 1),
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value.points, 0);
  const signals = Object.entries(dimensions).filter(([, value]) => value.present).map(([name]) => name);
  const reasonCodes: string[] = [];
  if (!(snapshot.terminal === "success" || snapshot.terminal === "unknown" && snapshot.executionCompleted === true) || raw.some((tool) => tool.status === "pending")) reasonCodes.push("execution_incomplete");
  if (successful.length < 2) reasonCodes.push("insufficient_independent_successful_evidence");
  if (!checks.length) reasonCodes.push("independent_verification_missing");
  const substantiveAnchor = chains.length || recoveries.length || investigations.length || coordinated;
  if (!substantiveAnchor) reasonCodes.push("no_substantive_complexity_signal");
  if (!substantiveAnchor && (unique.size <= 1 || observations.length - unique.size >= Math.ceil(observations.length / 2))) reasonCodes.push("mechanical_repetition");
  if (score < options.minComplexityScore) reasonCodes.push("complexity_score_below_threshold");
  return { version: COMPLEXITY_POLICY_VERSION, eligible: reasonCodes.length === 0, score, threshold: options.minComplexityScore,
    logicalSteps: raw.reduce((sum, tool) => sum + logicalSteps(tool), 0), uniqueOperations: unique.size, repeatedOperations: raw.length - unique.size,
    successfulEvidenceCount: successful.length, dimensions, signals, reasonCodes };
}
