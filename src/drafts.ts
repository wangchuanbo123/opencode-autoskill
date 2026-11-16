import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireFileLock } from "./lock.js";
import { ensurePrivateDirectory } from "./state.js";
import { QueueStore, type Publication } from "./jobs.js";
import { readOptions } from "./config.js";
import { parseDecision } from "./review.js";
import { SkillConflictError, SkillStore, type SaveOptions } from "./skills.js";
import type { ReviewDecision, ReviewProvenance, ToolRecord } from "./types.js";
import { resolveStorageLayout } from "./storage-layout.js";

const MAX_DRAFT_BYTES = 2_000_000;
const MAX_DRAFTS = 2_000;

export interface DraftRecord {
  id: string;
  decision: ReviewDecision;
  provenance: ReviewProvenance;
  evidence: ToolRecord[];
  expectedPreviousHash?: string;
  options?: Record<string, unknown>;
  createdAt?: string;
}

export interface DraftSummary {
  id: string;
  action: ReviewDecision["action"];
  skillId?: string;
  name?: string;
  reason: string;
  createdAt: string;
  status: "draft" | "published" | "discarded";
}

type PersistedDraft = DraftRecord & { status?: DraftSummary["status"]; published?: { path: string; sha256: string; version: string } };
export interface PublishDraftOptions { signal?: AbortSignal; }

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertDraftId(id: string): void {
  if (typeof id !== "string" || id.length < 1 || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "." || id === ".." ||
      !(/^[a-f0-9]{64}$/.test(id) || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) {
    throw new Error("Draft id must be a 64-character hex digest or portable lowercase kebab-case name.");
  }
}

function boundedString(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new Error(`Invalid draft ${label}.`);
}

function validateProvenance(value: unknown): asserts value is ReviewProvenance {
  if (!isObject(value)) throw new Error("Invalid draft provenance.");
  boundedString(value.sessionId, "provenance sessionId", 512);
  boundedString(value.fingerprint, "provenance fingerprint", 256);
  if (!Array.isArray(value.messageIds) || value.messageIds.length > 10_000 || value.messageIds.some((item) => typeof item !== "string" || item.length > 512)) throw new Error("Invalid draft provenance messageIds.");
  if (!Array.isArray(value.evidence) || value.evidence.length > 100) throw new Error("Invalid draft provenance evidence.");
  boundedString(value.createdAt, "provenance createdAt", 100);
}

function validateEvidence(value: unknown): asserts value is ToolRecord[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Invalid draft evidence.");
  const ids = new Set<string>();
  for (const item of value) {
    if (!isObject(item)) throw new Error("Invalid draft tool evidence.");
    boundedString(item.id, "tool id", 256); boundedString(item.name, "tool name", 256); boundedString(item.output, "tool output", 500_000);
    if (item.status !== "completed" && item.status !== "error" && item.status !== "pending") throw new Error("Invalid draft tool status.");
    if (ids.has(item.id)) throw new Error("Draft evidence contains duplicate tool ids.");
    ids.add(item.id);
  }
}

function validateRecord(value: unknown): asserts value is PersistedDraft {
  if (!isObject(value)) throw new Error("Invalid draft record.");
  assertDraftId(value.id as string);
  if (!isObject(value.decision) || !isObject(value.provenance)) throw new Error("Draft must contain decision and provenance.");
  validateProvenance(value.provenance);
  validateEvidence(value.evidence);
  if (value.expectedPreviousHash !== undefined && (typeof value.expectedPreviousHash !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedPreviousHash))) throw new Error("Invalid expectedPreviousHash.");
  if (value.options !== undefined && !isObject(value.options)) throw new Error("Draft options must be an object.");
  if (value.createdAt !== undefined) boundedString(value.createdAt, "createdAt", 100);
  if (value.status !== undefined && !["draft", "published", "discarded"].includes(value.status as string)) throw new Error("Invalid draft status.");
  if (value.published !== undefined && (!isObject(value.published) || typeof value.published.path !== "string" || !/^[a-f0-9]{64}$/.test(String(value.published.sha256)) || typeof value.published.version !== "string")) throw new Error("Invalid draft publication.");
}

function createdAt(value?: string): string {
  if (value !== undefined && Number.isFinite(Date.parse(value))) return value;
  return new Date().toISOString();
}

/** Private, reviewable candidates which can be published after explicit user approval. */
export class DraftStore {
  readonly root: string;
  readonly directory: string;
  private readonly lockDirectory: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.directory = path.join(resolveStorageLayout(this.root).stateRoot, "drafts");
    this.lockDirectory = path.join(resolveStorageLayout(this.root).stateRoot, "locks");
  }

  private async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await this.realDirectory(this.directory, true);
    await this.realDirectory(this.lockDirectory, true);
  }

  private async realDirectory(directory: string, create: boolean): Promise<void> {
    const root = resolveStorageLayout(this.root).stateRoot;
    const relative = path.relative(root, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Draft path escapes private storage.");
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe draft storage directory."); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return;
        await fs.mkdir(current, { mode: 0o700 });
      }
    }
  }

  private file(id: string): string { assertDraftId(id); return path.join(this.directory, `${id}.json`); }

  private async regular(file: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DRAFT_BYTES) throw new Error("Unsafe or oversized draft file.");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }

  private async read(id: string): Promise<PersistedDraft | undefined> {
    const file = this.file(id); if (!await this.regular(file)) return undefined;
    let value: unknown;
    try { value = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error(`Draft ${id} is not valid JSON.`); }
    validateRecord(value); return value;
  }

  private async atomic(file: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_DRAFT_BYTES) throw new Error("Draft exceeds the private storage limit.");
    await this.realDirectory(path.dirname(file), true);
    if (await this.regular(file)) { /* regular() also rejects links */ }
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temp, "wx", 0o600); await handle.writeFile(text, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temp, file);
    } finally { await handle?.close(); await fs.unlink(temp).catch(() => undefined); }
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await this.prepare();
    const release = await acquireFileLock(path.join(this.lockDirectory, `draft-${id}.lock`), () => this.prepare(), 5_000);
    if (!release) throw new SkillConflictError(`Draft ${id} is locked by another writer.`);
    try { return await fn(); } finally { await release(); }
  }

  private async validate(record: DraftRecord): Promise<{ record: PersistedDraft; options: ReturnType<typeof readOptions> }> {
    validateRecord(record);
    if (record.decision.action === "skip" || !record.decision.skill) throw new Error("Only create or update decisions with a skill can be drafted.");
    const options = readOptions(record.options ?? {});
    const skills = await new SkillStore(this.root).list();
    const decision = parseDecision(JSON.stringify(record.decision), new Map(record.evidence.map((tool) => [tool.id, tool])), skills, options, this.root);
    const normalized: PersistedDraft = { ...record, decision, createdAt: createdAt(record.createdAt), status: record.status ?? "draft" };
    return { record: normalized, options };
  }

  async create(input: DraftRecord): Promise<DraftRecord> {
    assertDraftId(input.id);
    return this.withLock(input.id, async () => {
      const existing = await this.read(input.id);
      if (existing) {
        if (existing.provenance.fingerprint === input.provenance.fingerprint && existing.provenance.taskId === input.provenance.taskId &&
            existing.expectedPreviousHash === input.expectedPreviousHash && isDeepStrictEqual(existing.decision, input.decision) && isDeepStrictEqual(existing.evidence, input.evidence)) return existing;
        throw new SkillConflictError(`Draft ${input.id} already exists with different evidence or content.`);
      }
      const { record } = await this.validate({ ...input, status: "draft" } as DraftRecord);
      if (await new SkillStore(this.root).list().then((items) => items.some((item) => item.id === record.decision.skill?.id && record.decision.action === "create"))) {
        throw new SkillConflictError("Skill id already exists.");
      }
      await this.atomic(this.file(record.id), record);
      return record;
    });
  }

  async list(): Promise<DraftSummary[]> {
    await this.prepare();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const output: DraftSummary[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5); try { assertDraftId(id); } catch { continue; }
      const record = await this.read(id); if (!record) continue;
      output.push({ id, action: record.decision.action, skillId: record.decision.skill?.id,
        name: record.decision.skill?.name, reason: record.decision.reason, createdAt: createdAt(record.createdAt), status: record.status ?? "draft" });
    }
    if (output.length > MAX_DRAFTS) throw new Error("Too many AutoSkill drafts; inspect and remove stale drafts.");
    return output;
  }

  async inspect(id: string): Promise<DraftRecord> {
    await this.prepare();
    const record = await this.read(id); if (!record) throw new Error(`Draft ${id} does not exist.`);
    // Inspect is deliberately a read-only operation: a published or conflicted
    // candidate must remain reviewable even when it no longer passes current
    // skill-collision checks. Creation and publication perform semantic validation.
    return record;
  }

  private async queueUpdate(id: string, status: "saved" | "skipped", result: { status: "saved" | "skipped"; reason: string; skillId?: string; path?: string; taskId?: string }, publication?: Publication, expectedFingerprint?: string): Promise<void> {
    const queue = new QueueStore(this.root);
    try {
      await queue.transaction((state) => {
        const job = state.jobs[id]; if (!job) return;
        if (expectedFingerprint !== undefined && job.fingerprint !== expectedFingerprint) throw new SkillConflictError(`Queue job ${id} evidence no longer matches this draft.`);
        if (!["draft", "saved", "skipped"].includes(job.status)) throw new SkillConflictError(`Queue job ${id} is ${job.status}; refusing to overwrite it.`);
        job.status = status; job.result = result; job.publication = publication ?? job.publication; job.updatedAt = Date.now();
        delete job.lease;
      });
    } finally { await queue.close(); }
  }

  private async priorPublication(record: PersistedDraft, store: SkillStore): Promise<{ path: string; id: string; changed: boolean; sha256: string; version: string } | undefined> {
    const skillId = record.decision.skill?.id; if (!skillId) return undefined;
    try {
      const inspected = await store.inspect(skillId), source = inspected.provenance as { taskId?: string; fingerprint?: string; skillSha256?: string; version?: string } | undefined;
      if (source?.taskId !== record.id || source.fingerprint !== record.provenance.fingerprint || source.skillSha256 !== inspected.skill.sha256) return undefined;
      return { path: inspected.skill.path, id: skillId, changed: false, sha256: inspected.skill.sha256, version: source.version ?? inspected.skill.version ?? "unknown" };
    } catch { return undefined; }
  }

  async publish(id: string, publishOptions: PublishDraftOptions = {}): Promise<{ path: string; id: string; changed: boolean; sha256: string; version: string; jobId: string }> {
    return this.withLock(id, async () => {
      const record = await this.read(id); if (!record) throw new Error(`Draft ${id} does not exist.`);
      if (record.status === "discarded") throw new Error(`Draft ${id} was discarded.`);
      const store = new SkillStore(this.root);
      let checked: PersistedDraft; let options: ReturnType<typeof readOptions>;
      try { ({ record: checked, options } = await this.validate(record)); }
      catch (error) {
        const recovered = await this.priorPublication(record, store); if (!recovered) throw error;
        await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft publication was already committed.", skillId: recovered.id, path: recovered.path, taskId: id }, { stage: "committed", ...recovered, updatedAt: Date.now() }, record.provenance.fingerprint);
        return { ...recovered, jobId: id };
      }
      const skill = await store.list().then((items) => items.find((item) => item.id === checked.decision.skill?.id));
      if (checked.expectedPreviousHash !== undefined && skill?.sha256 !== checked.expectedPreviousHash) {
        const recovered = await this.priorPublication(checked, store); if (!recovered) throw new SkillConflictError("Skill changed since this draft was created.");
        await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft publication was already committed.", skillId: recovered.id, path: recovered.path, taskId: id }, { stage: "committed", ...recovered, updatedAt: Date.now() }, checked.provenance.fingerprint);
        return { ...recovered, jobId: id };
      }
      const provenance = { ...checked.provenance, taskId: id };
      const saved = await store.save(checked.decision, provenance, { expectedPreviousHash: checked.expectedPreviousHash, signal: publishOptions.signal, maxManagedSkills: options.maxManagedSkills } satisfies SaveOptions);
      await this.queueUpdate(id, "saved", { status: "saved", reason: "Draft published.", skillId: saved.id, path: saved.path, taskId: id }, { stage: "committed", ...saved, updatedAt: Date.now() }, checked.provenance.fingerprint);
      checked.status = "published"; checked.published = saved; await this.atomic(this.file(id), checked);
      return { ...saved, jobId: id };
    });
  }

  async discard(id: string): Promise<{ id: string; status: "discarded" }> {
    return this.withLock(id, async () => {
      const record = await this.read(id); if (!record) throw new Error(`Draft ${id} does not exist.`);
      if (record.status === "published") throw new Error(`Published draft ${id} cannot be discarded.`);
      await this.queueUpdate(id, "skipped", { status: "skipped", reason: "Draft discarded.", skillId: record.decision.skill?.id, taskId: id }, { stage: "committed", updatedAt: Date.now() }, record.provenance.fingerprint);
      record.status = "discarded"; await this.atomic(this.file(id), record);
      return { id, status: "discarded" as const };
    });
  }
}

