export interface ModelRef {
  providerID: string;
  id: string;
}

export interface ToolRecord {
  id: string;
  name: string;
  status: "completed" | "error" | "pending";
  input?: unknown;
  output: string;
  nativeName?: string;
  category?: "read" | "write" | "execute" | "search" | "verify" | "other";
  nativeCallId?: string;
  sourceEventId?: string;
}

export type TaskTerminal = "success" | "failure" | "interrupted" | "idle" | "unknown";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolRecord[];
  finish?: string;
  error?: string;
  createdAt?: number;
  completedAt?: number;
}

export interface TaskSnapshot {
  sessionId: string;
  directory: string;
  messages: ConversationMessage[];
  terminal: TaskTerminal;
  model?: ModelRef;
  parentId?: string;
  agent?: string;
  hostId?: string;
  workspaceId?: string;
  turnId?: string;
  revision?: string | number;
  origin?: { kind: "user" | "reviewer" | "maintenance" | "subagent"; parentTaskId?: string };
  /** A trusted host observed execution ending; this does not assert task success. */
  executionCompleted?: boolean;
  /** Explicit task outcomes, keyed by the user message opening each task. */
  taskBoundaries?: { messageId: string; terminal: TaskTerminal; executionCompleted?: boolean }[];
}

export interface SkillCompatibility {
  hosts?: string[];
  requiredCapabilities?: string[];
}

export interface SkillContent {
  id: string;
  name: string;
  description: string;
  whenToUse: string[];
  prerequisites: string[];
  steps: string[];
  pitfalls: string[];
  verification: string[];
  compatibility?: SkillCompatibility;
}

export interface EvidenceCitation {
  toolCallId: string;
  excerpt: string;
  supports: "procedure" | "verification";
}

export interface AssessmentCitation { toolCallId: string; excerpt: string; }
export type ComplexityDimension = "dependent-steps" | "diagnosis-and-recovery" | "tradeoff-decision" | "cross-boundary-coordination";
export interface ReviewAssessment {
  complexity: {
    nontrivial: boolean;
    dimensions: { kind: ComplexityDimension; rationale: string; evidence: AssessmentCitation[] }[];
  };
  value: {
    transferable: boolean;
    nonObvious: boolean;
    addsKnowledge: boolean;
    rationale: string;
    evidence: AssessmentCitation[];
  };
}

export interface ReviewDecision {
  action: "skip" | "create" | "update";
  reason: string;
  taskCompleted: boolean;
  reusable: boolean;
  confidence: number;
  skill?: SkillContent;
  evidence?: EvidenceCitation[];
  assessment?: ReviewAssessment;
}

export interface ExistingSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  content?: string;
  contentComplete?: boolean;
  managed: boolean;
  title?: string;
  sha256?: string;
  generatedHash?: string;
  ownership?: "managed" | "user-modified" | "unmanaged";
  pinned?: boolean;
  archived?: boolean;
  version?: string;
  usageCount?: number;
  lastUsedAt?: string;
  feedback?: { success: number; failure: number };
  updatedAt?: string;
  versionFeedback?: { success: number; failure: number };
  reuseFeedback?: { loaded: number; reportedUsed: number; user: { success: number; failure: number }; model: { success: number; failure: number } };
  compatibility?: SkillCompatibility;
  compatibilityInvalid?: boolean;
}

export interface ReviewProvenance {
  sessionId: string;
  fingerprint: string;
  messageIds: string[];
  evidence: EvidenceCitation[];
  createdAt: string;
  schemaVersion?: number;
  pluginVersion?: string;
  templateHash?: string;
  model?: ModelRef;
  taskId?: string;
  decisionReason?: string;
  assessment?: ReviewAssessment;
  hostId?: string;
  workspaceId?: string;
  turnId?: string;
  revision?: string | number;
}

export interface AutoSkillOptions {
  enabled: boolean;
  agentPolicy: "root-only" | "inherit" | "independent";
  /** @deprecated Accepted for configuration compatibility; no longer grants review eligibility. */
  minToolCalls: number;
  /** @deprecated Accepted for configuration compatibility; failures alone do not indicate complexity. */
  minToolCallsWithErrors: number;
  debounceMs: number;
  cooldownMs: number;
  maxReviewsPerDay: number;
  reviewTimeoutMs: number;
  maxTranscriptChars: number;
  maxToolOutputChars: number;
  maxSkillChars: number;
  minConfidence: number;
  maxAttempts: number;
  language: string;
  model?: ModelRef;
  mode: "auto" | "draft";
  minComplexityScore: number;
  maxPromptChars: number;
  maxEstimatedInputTokens: number;
  relevantSkillLimit: number;
  maxManagedSkills: number;
  maxGlobalReviewsPerDay: number;
  maxGlobalEstimatedTokensPerDay: number;
  maxEstimatedTokensPerDay: number;
  retryBaseMs: number;
  retryMaxMs: number;
  providerAllowlist: string[];
  excludeTools: string[];
  excludeFiles: string[];
  excludeSessions: string[];
  sensitivePatterns: string[];
  storeEvidence: "none" | "redacted";
  globalStateDirectory?: string;
  reuseEnabled: boolean;
  reuseCandidateLimit: number;
  reuseAutoLoadLimit: number;
  reuseMinScore: number;
  reuseAutoLoadScore: number;
  reuseStaleAfterDays: number;
  reuseMaxContextChars: number;
  reuseMaxSkillChars: number;
  reuseTimeoutMs: number;
}

export interface ReviewResult {
  status: "saved" | "skipped" | "failed" | "busy" | "queued" | "draft" | "cancelled";
  reason: string;
  skillId?: string;
  path?: string;
  reasonCode?: string;
  taskId?: string;
  nextRunAt?: number;
}

export interface HostCapabilities {
  hostVersion?: string;
  supported: boolean;
  missing: string[];
}

export interface EnginePort {
  root: string;
  hostId?: string;
  workspaceId?: string;
  /** Explicit host proof that does not change legacy task IDs. */
  compatibilityHostId?: string;
  /** Capabilities observed or configured by the adapter, never assumed from a model name. */
  hostCapabilities?: string[];
  /** Disable automatic draining in short-lived capture hooks. Manual review remains available. */
  backgroundWorker?: boolean;
  options?: Record<string, unknown>;
  capabilities?: HostCapabilities;
  reuseCapabilities?: HostCapabilities;
  snapshot(sessionId: string, terminal: TaskSnapshot["terminal"], signal?: AbortSignal): Promise<TaskSnapshot>;
  generate(input: { sessionId: string; prompt: string; model?: ModelRef; signal: AbortSignal }): Promise<string>;
  listSkills(signal?: AbortSignal): Promise<ExistingSkill[]>;
  reloadSkills(signal?: AbortSignal): Promise<void>;
  log(level: "info" | "warn" | "error", message: string): void;
}
