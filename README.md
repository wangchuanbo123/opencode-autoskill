<div align="center">

# OpenCode AutoSkill

### Turn verified task experience into reusable project skills

**English** · [简体中文](README.zh-CN.md)

![Version](https://img.shields.io/badge/version-0.4.0-2563eb)
![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D2.2.7%20%3C2.3.0-2563eb)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.18-43853d)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

Automatic review · Relevant skill retrieval · Evidence checks · Cross-platform adapters

</div>

> **An unofficial community plugin.** This project is not built by, affiliated with, or endorsed by the OpenCode team.
> Integration tested on **Windows with OpenCode 2.2.7 and local mock models**. Other versions, clients and real-model quality have separate validation limits below.

## Navigation

[Quick start](#quick-start) · [Skill reuse](#how-automatic-reuse-works) · [Distillation](#how-automatic-distillation-works) · [Diagnostics](#status-and-diagnostics) · [Skill management](#manage-generated-skills) · [Configuration](#configuration) · [Privacy](#files-and-privacy) · [Cross-platform guide](CROSS_PLATFORM.md) · [Evaluation](evaluation/README.md)

## Why AutoSkill?

| Capability | What it helps you do |
|---|---|
| Learn from completed tasks | Save methods supported by verification evidence as project skills |
| Retrieve for each new task | Find relevant experience using the task topic, environment and prerequisites |
| Keep context bounded | Load up to 5 summaries and 2 complete skills by default, within character budgets |
| Protect team knowledge | Track content hashes and versions, and preserve manual edits |
| Use feedback carefully | Keep model usage reports, task outcomes and user ratings separate |
| Connect multiple agents | Use a shared core, platform hooks and MCP, with explicit capability limits |

AutoSkill reviews substantive tasks during normal OpenCode use. It saves reusable methods with supporting evidence, then checks whether they apply to later tasks. The workflow covers **distillation → matching → loading → use → feedback**. It runs automatically by default; no per-task confirmation or `/learn` command is required. Reuse uses the plugin API and requires no OpenCode source changes.

**Compatibility:** OpenCode `>=2.2.7 <2.3.0`, Node.js `>=22.18`. Version **2.2.7** has been tested; other versions within the accepted range still require validation.

**Generated language:** skills default to Simplified Chinese (`zh-CN`). To generate English skills, set `"language": "en"` in the plugin's `options`; see [configuration](#configuration). Choosing a README language does not change runtime settings.

## Quick start

Choose the setup for your host:

| Host | Setup and capabilities |
|---|---|
| **OpenCode** | Native automatic review and reuse; uses the host's configured model. Follow the steps below. |
| **Claude Code / Codex / Gemini CLI / Cursor** | Local adapters with platform hooks and a shared skill library. See [installation](CROSS_PLATFORM.md#installation) and [reviewer configuration](CROSS_PLATFORM.md#configure-the-reviewer). |
| **Other MCP clients** | Install with `--host generic`, register the generated server entry, and use search/load on demand. See [generic MCP setup](CROSS_PLATFORM.md#connect-a-generic-mcp-client). Generic MCP does not passively capture tasks. |

The other host adapters have process/protocol tests; this does not establish acceptance in every real client. Migration, native export and host-specific limits are documented in the [cross-platform guide](CROSS_PLATFORM.md).

### Install from source

Configure a working model in OpenCode first. The package is not currently published on the npm registry; install from the public source repository. Replace `PATH_TO_YOUR_PROJECT` with your project's absolute path:

```sh
git clone https://github.com/wangchuanbo123/opencode-autoskill.git
cd opencode-autoskill
npm ci
npm run build
node bin/autoskill.mjs install --project "PATH_TO_YOUR_PROJECT"
node bin/autoskill.mjs doctor --project "PATH_TO_YOUR_PROJECT"
```

Reload OpenCode, then work normally. Keep the cloned plugin directory: the installer registers its absolute path in your project's configuration.

The remaining examples use PowerShell paths such as `D:\your-project`. Substitute your own paths. To inspect results:

```powershell
node bin/autoskill.mjs status --runtime --project D:\your-project
node bin/autoskill.mjs skills list --project D:\your-project
```

The installer updates `opencode.jsonc` in the project root, or `opencode.json` if that file already exists. It preserves comments, other plugins and configuration. If both files exist, select one with `--config D:\your-project\opencode.jsonc`; any accompanying `--project` must name that file's directory.

### Install a local package archive

If you have built a `.tgz`, install it with npm and run its CLI:

```powershell
npm install --prefix D:\plugins\autoskill-host D:\downloads\opencode-autoskill-0.4.0.tgz
node D:\plugins\autoskill-host\node_modules\opencode-autoskill\bin\autoskill.mjs install --project D:\your-project
```

When its executable is on your `PATH`, `opencode-autoskill` can replace `node bin/autoskill.mjs`. The installed directory must remain available. If you extract a `.tgz` directly, run `npm install --omit=dev --ignore-scripts` in the extracted `package/` directory to install runtime dependencies.

## How automatic reuse works

```text
A new user task starts
  → Retrieve skills still managed by the plugin in this project
  → Check hashes, prerequisites, stack, versions, age and feedback
  → Rank and deduplicate up to 5 candidate summaries
  → Automatically load up to 2 highly relevant skills with known prerequisites
  → Let the main model assess other candidates and call autoskill_load if needed
  → Apply the method to the current task and verify the result
  → Record loading, model reports, task outcomes and user feedback
```

Each new task attempts local retrieval without a separate model request for matching. Candidates and loads are associated with the user message ID so a previous task's matches are not applied to a new request. Tasks with no relevant skill proceed normally; retrieval failures and timeouts do not block the main task.

OpenCode reuse failure logs include the `hook` stage, a fixed `reason` category and `elapsedMs`, helping distinguish timeouts, lock contention and file access failures. They omit raw exception text, task text and file paths.

The host adapter uses `session.hook("prompt")` to prepare retrieval when input arrives and `session.hook("context")` to rebuild reuse context for the current user message before the main model call. Queued input also has its own task association. The plugin preserves user messages and explicit skill attachments and supplies reuse context alongside the main task. Child sessions and tasks outside the current project are excluded from this automatic path.

### Bound context and avoid unsuitable skills

Local retrieval combines specific task topics, skill titles and use cases, and the observed project environment. Generic requests such as “fix,” “inspect,” or “run tests” cannot trigger a domain skill on their own. Chinese technical terms participate in retrieval. The implementation uses keywords, a limited technical-term mapping and explicit condition checks. It has no vector database and does not claim to recognize every semantically equivalent problem.

Candidate summaries and complete bodies have separate count and character budgets. Defaults are **5 candidates and 2 complete skills**. A body enters the current task's context only after selection. Summaries contain only a title, description, score and reasons; status records retain skill hashes and versions for inspection.

`reuseAutoLoadLimit` accepts `0–2`. A task can load at most 2 skills in total, including explicit selections. The default body limit is 6,000 characters per skill and the overall reuse-context limit is 16,000 characters. If the complete procedure and verification do not fit, the candidate remains a summary; the plugin does not supply a body cut off halfway through.

Automatic reuse excludes archived skills, ownership-hash mismatches, manual edits, explicit environment or runtime-version conflicts, stale versions, repeated negative feedback, sensitive content and incomplete bodies. By default, versions older than **180 days** are excluded from the current candidates; they need revalidation and are not deleted. Pinned skills remain eligible for reuse: pinning protects updates and cleanup only.

Automatic loading requires explicitly satisfied prerequisites. A prerequisite that cannot be established from the current project downgrades the candidate to “needs assessment.” For example, a skill may require a reproducible failure fixture that is only mentioned in the task description. Known framework, runtime-version or platform conflicts exclude candidates. Environment detection and textual condition parsing have limits; the main model must check actual constraints before execution.

Environment detection reads only size-limited project manifests and known marker files. It does not run probing commands or scan user directories. The plugin's own runtime version is not automatically treated as a project subprocess version. When a version requirement cannot be established, the model must verify it.

Duplicate methods produce one candidate. Similar topics with conflicting methods are downgraded for model assessment to avoid automatically loading mutually exclusive procedures. Historical success feedback makes only a small ranking adjustment; it cannot let an unrelated skill bypass matching or environment checks. Scores are routing heuristics, **not probabilities of applicability or success**.

### Loading and actual use

For a highly relevant skill with clear prerequisites, the plugin supplies the full body as reference context and asks the model to prefer it. Current user instructions, project constraints and permissions still apply. An explicit request not to use skills disables automatic reuse; exclusions for a particular topic affect only that topic.

Loading a skill does not execute its commands. A complete load proves only that the content was supplied to the model. Actual adoption and whether the method contributed to success require usage reports, execution evidence and user feedback. New facts may still make a skill unsuitable; the main model should explain that decision.

Automatic reuse currently covers only **plugin-generated skills whose content hashes match their private provenance records**. Handwritten, external and manually edited skills retain native discovery. The plugin neither rewrites those bodies nor manages them automatically. To return a manually edited skill to plugin management, inspect it first and explicitly run `skills adopt`.

### Feedback and governance

Load counts, model-reported use, task success/failure/interruption and explicit user feedback are recorded separately. Task success does not establish that a skill was effective. The model's `autoskill_feedback` report is not a user rating.

Feedback can lower low-value candidates' rankings or stop their automatic recommendation. `skills pin/archive/restore/rollback/prune` manages skills and retained versions. Retrieval deduplication does not directly rewrite or merge similar bodies. A new distillation still needs verified improvement, ownership checks and version checks.

Inspect reuse status, version-level statistics and task associations:

```powershell
node bin/autoskill.mjs reuse status --project D:\your-project
node bin/autoskill.mjs reuse history --project D:\your-project
node bin/autoskill.mjs reuse history <skill-id> --project D:\your-project
```

To rate an actual usage record, specify the session and user message IDs shown in status:

```powershell
node bin/autoskill.mjs reuse feedback <skill-id> --session <session-id> --task <user-message-id> --outcome success --project D:\your-project
```

`--outcome` accepts `success`, `failure` or `unknown`. Feedback has `source: "user"` and is associated with the hash actually loaded at that time. Feedback on an older body does not count toward its replacement. If edits to one user message produced multiple retrieval revisions, select one with `--query-hash <hash>`. Model tools cannot write user-sourced ratings.

The older `skills feedback` command still records overall skill feedback and retains feedback on the current body version for retrieval. Task-level `reuse feedback` writes to a separate ledger without also incrementing the older counter, preventing double counting.

Governance returns recommendations by default. Preview before applying:

```powershell
node bin/autoskill.mjs reuse govern --project D:\your-project
node bin/autoskill.mjs reuse govern --apply --dry-run --project D:\your-project
node bin/autoskill.mjs reuse govern --apply --project D:\your-project
```

Recommendations use user feedback on the current version and its age. A model report or failed task is not automatically treated as skill failure. Before archiving, the plugin rechecks managed ownership, content hash and pin status. Archived skills can be restored with `skills restore`. Overlapping coverage produces a recommendation to retain a primary skill; bodies are not automatically rewritten, concatenated or merged.

## How automatic distillation works

```text
OpenCode finishes an execution turn
  → Split evidence at user-task boundaries and retain unprocessed evidence
  → Filter, redact and truncate task evidence; add it to the persistent queue
  → Screen for dependencies, diagnosis, coordination and independent verification
  → Reserve project/user call budgets and select relevant existing skills
  → Ask the model to assess substantive complexity and reusable value separately
  → Check completion, structured assessments, quality and evidence references
  → Create/update SKILL.md automatically, or save a draft
  → Refresh the skill list and record the decision and reasons
```

One task can produce a skill. Review eligibility and publication are separate decisions. Version 0.3 removed the shortcut that admitted tasks after “8 calls, or 4 calls with a failure.” Reading many files, repeating commands, retrying after typos or making the same replacement in bulk is not substantive complexity by count alone.

### Assess complexity and reusable value

| Decision layer | Required signals | Insufficient signals |
|---|---|---|
| Deterministic screening: is a model review worthwhile? | Nonmechanical step dependencies, diagnosis and method changes, related coordination across resources, or investigative findings with independent checks; completed work and enough valid evidence are required | Call/file/failure counts, a user's “complex” label, or an assistant's completion claim |
| Model complexity assessment | Explain where judgment was needed, why steps depended on one another or why the original method failed; cite actual tool evidence | Listing operations again or repeating scores and tool names |
| Model reusable-value assessment | Transferable triggers, executable verified methods, and additional coverage beyond existing skills | Length, one-off project details, self-reported confidence, or duplicate methods |

Screening deduplicates equivalent operations. Code Mode inspects internal operations, but simply stacking `await read(...)` calls adds no substantive complexity. Two tool calls can qualify if they include a concrete root-cause diagnosis and independent regression verification. Complex read-only investigations may qualify through independent sources. Sessions with multiple tasks are still split at task boundaries.

The current screening strategy is `evidence-v1`. It requires at least two deduplicated, valid, successful tool-evidence items and a later independent tool call verifying the same issue. It also requires at least one of: a completed dependency chain, a method change after diagnosis, related coordination across resources, or verification of investigative findings. Dimensions are additive:

| Evidence dimension | Points |
|---|---:|
| Inspection → related change → later independent verification | 5 |
| Nonmechanical failure → root-cause diagnosis → method change → independent verification | 6 |
| Explicitly related coordination across resources | 4 |
| Read-only finding → later independent verification | 5 |
| Causal, dependency or comparative reasoning in tool output | 3 |
| Successful verification evidence | 2 |
| At least two of inspection, change and verification | 1 |

The default minimum total is `11`. The score controls review cost. Lowering it does not let repeated operations or ordinary retries bypass the substantive-evidence requirements. It is neither a measurement of difficulty nor a probability of success.

Screening is an explainable, conservative heuristic intended to reduce unhelpful reviews; it cannot establish semantic complexity. The model must provide separate structured assessments of complexity and reusable value with checkable evidence. Publication checks those assessments, references, verification and relationships to existing skills. Both rules and models can misjudge; generated skills are not guaranteed to be correct or useful.

A completion event only triggers inspection. The model must still assess task completion and cite checkable verification within the task. The plugin checks structure, references and candidate quality; it does not rerun the generated verification steps. Actual distillation quality and reuse effectiveness require ongoing observation.

Background work uses a persistent SQLite queue. Short transactions claim jobs; model calls run outside database transactions. Retryable failures use backoff, and interrupted work resumes after restart. Sessions are processed in sequence, while concurrent processes coordinate through the database. Writes use version checks and atomic replacement so interrupted publication can be reconciled.

**There is no separate daemon that continues distillation after OpenCode exits.** Queued tasks remain and resume when the same project starts again. A short-lived `opencode run` may exit before completion evidence is captured. Use interactive OpenCode or a persistent `opencode serve` for reliable automatic capture and review.

## Status and diagnostics

```powershell
node bin/autoskill.mjs status --runtime --project D:\your-project
node bin/autoskill.mjs doctor --project D:\your-project
node bin/autoskill.mjs doctor --opencode D:\tools\opencode.exe --project D:\your-project
node bin/autoskill.mjs recover --dry-run --project D:\your-project
node bin/autoskill.mjs recover --project D:\your-project
```

`status` shows configuration and installation state. `--runtime` adds queue counts, task summaries, recent decisions, reason codes, counters and observed host capabilities. A task's `preScreen` includes the screening strategy version, score, dimensions and rejection reasons. Projects never run show `not-started`. Output does not include queued conversation-evidence bodies.

`doctor` checks configuration, unknown or invalid options, missing local plugin references, module import in a subprocess and the CLI version. It also reports whether the plugin is enabled globally. Set `OPENCODE_BIN` to choose the CLI. Only **2.2.7** is marked tested; other versions require validation. Successful module import and actual host activation are shown separately; capability reporting is based on runtime observations.

`recover` reclaims expired execution leases instead of simply deleting lock files. Running jobs with valid leases remain active. Old v0.1 state is migrated; locks belonging to confirmed dead legacy processes are retained as diagnostic records. Corrupt or indeterminate legacy locks require inspection to avoid confusing them with a live instance.

The following model tools are also available in OpenCode:

| Tool | Purpose |
|---|---|
| `autoskill_status` | Inspect runtime state |
| `autoskill_review` | Review unprocessed tasks before the latest completion boundary; `dryRun=true` saves candidates without publishing a skill |
| `autoskill_load` | Load a candidate for the current task on demand, rechecking ownership, version and budgets |
| `autoskill_search` | Retrieve candidate summaries for the current task or a specific follow-up question; up to 5 by default, respecting the task's skill exclusions |
| `autoskill_feedback` | Report whether the model used a skill and the result; stored separately from explicit user feedback |

These are model tools, not slash commands. Normal use needs no manual trigger.

## Manage generated skills

```powershell
node bin/autoskill.mjs skills list --project D:\your-project
node bin/autoskill.mjs skills inspect <skill-id> --project D:\your-project
node bin/autoskill.mjs skills pin <skill-id> --project D:\your-project
node bin/autoskill.mjs skills unpin <skill-id> --project D:\your-project
node bin/autoskill.mjs skills archive <skill-id> --project D:\your-project
node bin/autoskill.mjs skills restore <skill-id> --project D:\your-project
node bin/autoskill.mjs skills rollback <skill-id> --version <version> --project D:\your-project
node bin/autoskill.mjs skills adopt <skill-id> --project D:\your-project
node bin/autoskill.mjs skills feedback <skill-id> --outcome success --notes "Successfully reused in practice" --project D:\your-project
node bin/autoskill.mjs skills prune --keep 50 --older-than 30 --dry-run --project D:\your-project
```

`list` returns summaries; `inspect` shows the body, provenance and available rollback versions. These subcommands are also available directly, for example `opencode-autoskill pin <skill-id>`.

- **Manual-edit protection:** content hashes detect changes. Automatic updates affect only managed, unpinned skills. Handwritten and manually edited bodies are not overwritten automatically.
- **Pinning:** `pin` blocks automatic updates and cleanup; `unpin` removes that protection.
- **Archive and restore:** `archive` removes a skill from the active skill directory; `restore` brings it back. `rollback` restores a historical version listed by `inspect` without silently overwriting manual edits.
- **Adoption:** `adopt` explicitly returns the current body to plugin management. Inspect it first; later automatic updates use it as the baseline.
- **Feedback and cleanup:** record success or failure. `prune` archives only old, managed, unpinned skills. It first retains the `--keep` most recently used skills, then applies `--older-than`. The default is 50 retained skills.

Mutation commands support `--dry-run`. `maxManagedSkills` limits managed capacity; handwritten skills are never deleted automatically.

## Draft mode

With `"mode": "draft"`, screening and distillation still run automatically. Drafts are saved in the private runtime directory. Publishing an existing draft does not call the model again:

```powershell
node bin/autoskill.mjs drafts list --project D:\your-project
node bin/autoskill.mjs drafts inspect <draft-id> --project D:\your-project
node bin/autoskill.mjs drafts publish <draft-id> --dry-run --project D:\your-project
node bin/autoskill.mjs drafts publish <draft-id> --project D:\your-project
node bin/autoskill.mjs drafts discard <draft-id> --project D:\your-project
```

Publication rechecks references, quality and the current skill version. A changed body or newly pinned target blocks overwrite; the draft remains available for inspection. The default is `mode: "auto"`, with no per-draft publication step.

### Upgrade to v0.3

Existing published skills remain and are not distilled again merely because the screening strategy version changes. Tasks previously skipped for insufficient complexity can be reassessed under the new strategy at the next check. Queued jobs not yet executed also use the new rules.

Legacy drafts lacking the structured complexity and value assessments required by v0.3 cannot be published directly. Recovery reports `legacy_draft_requires_review`. Inspect them with `drafts inspect`, or remove them with `drafts discard`. A compliant replacement requires a new completed task in OpenCode that passes the current review. There is no command to retrofit a review onto an old draft or force its publication.

## Files and privacy

```text
your-project/
└─ .opencode/
   ├─ skills/<skill-id>/SKILL.md      # Skill body that can be shared with your team
   └─ autoskill/                    # Automatically ignored private runtime directory
      ├─ runtime.sqlite             # Authoritative queue state
      ├─ reuse.sqlite               # Task/skill-version stages, model reports, user feedback
      ├─ state.json                 # Diagnostic projection without conversation bodies
      ├─ events.jsonl               # Events and decisions
      ├─ provenance/<id>/SOURCE.json # Provenance, fingerprints and evidence references
      ├─ drafts/                    # Unpublished drafts
      └─ backups/                   # Historical skill versions

user-private-state/
├─ config-backups/<config-path-hash>/ # Latest 10 backups per configuration file
├─ installations/                   # Installation identities for path migration
└─ …                                # Cross-project call budgets
```

Ignore rules are added automatically for project runtime and user-private state directories. Generated `SKILL.md` files do not carry full source evidence. Legacy provenance records beside skills are safely migrated into the private directory. Your team decides whether to commit skill bodies.

The reuse ledger stores only task/skill IDs, query hashes, skill-content hashes, stages and feedback statistics. It does not store original user-task text or complete skill bodies. Recent detailed stages are compacted while retaining information needed for deduplication and per-version totals.

The default user-private state directory is `$XDG_STATE_HOME/opencode-autoskill`, or `~/.local/state/opencode-autoskill` when unset. Override it with `AUTOSKILL_STATE_HOME`. Configuration backups may contain credentials, so they are stored there, isolated by configuration path and limited to 10 per file. Do not set the state directory to the project root or an ancestor of the project.

Distillation sends conversation summaries and tool evidence to the selected model provider and consumes quota. You can configure a provider allowlist, file/tool/session exclusions and literal sensitive-text fragments. Both input and candidate bodies undergo common-key redaction. `storeEvidence: "none"` omits evidence excerpts from provenance. Redaction cannot guarantee recognition of arbitrary private content.

Old evidence from terminal jobs can be cleaned up. The default retention period is 30 days; preview first:

```powershell
node bin/autoskill.mjs clean --older-than 30 --dry-run --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --project D:\your-project
```

`clean` removes age-eligible terminal task snapshots, evidence excerpts in provenance/backups, and evidence from published or discarded drafts. It preserves pending jobs, unpublished drafts, skill bodies, content hashes, ownership and deduplication records. Do not delete the entire runtime directory to clean evidence: doing so loses provenance needed for manual-edit protection and deduplication.

## Configuration

Edit this plugin's `options` entry in `plugins`. See the complete [example configuration](examples/opencode.jsonc). Unknown fields and invalid values produce explicit errors instead of silently ignoring typos.

| Option | Default | Purpose |
|---|---|---|
| `enabled` / `mode` | `true` / `"auto"` | Enable automatic operation; `"draft"` saves drafts only |
| `reuseEnabled` | `true` | Enable automatic retrieval, matching and context loading for new tasks |
| `reuseCandidateLimit` / `reuseAutoLoadLimit` | `5` / `2` | Maximum candidate summaries / automatically loaded complete skills per task |
| `reuseMinScore` / `reuseAutoLoadScore` | `0.16` / `0.62` | Local relevance thresholds for candidates / automatic loads; constraints, conflict and safety checks still apply |
| `reuseStaleAfterDays` | `180` | Stop recommending older versions automatically; preserve bodies |
| `reuseMaxContextChars` / `reuseMaxSkillChars` | `16000` / `6000` | Character budgets for task reuse context / a complete skill |
| `reuseTimeoutMs` | `5000` | Timeout for one reuse preparation; the main task continues on failure |
| `minToolCalls` / `minToolCallsWithErrors` | `8` / `4` | Deprecated compatibility options; parsed for old configurations but no longer admit tasks |
| `minComplexityScore` | `11` | Minimum automatic screening score; substantive signals and verification remain mandatory |
| `debounceMs` / `cooldownMs` | `2000` / `60000` | Wait for events to settle / interval between reviews in the same session |
| `maxReviewsPerDay` / `maxGlobalReviewsPerDay` | `20` / `100` | Daily model-call limits per project / user |
| `maxEstimatedTokensPerDay` / `maxGlobalEstimatedTokensPerDay` | `250000` / `1000000` | Daily estimated input-token limits per project / user |
| `maxEstimatedInputTokens` / `maxPromptChars` | `40000` / `80000` | Estimated token / character budget for a complete prompt |
| `maxTranscriptChars` / `maxToolOutputChars` | `60000` / `6000` | Character limits for a transcript / one tool output |
| `reviewTimeoutMs` | `90000` | Timeout for one distillation call |
| `maxAttempts` / `retryBaseMs` / `retryMaxMs` | `2` / `5000` / `300000` | Maximum attempts and retry-backoff settings |
| `minConfidence` / `maxSkillChars` | `0.85` / `16000` | Minimum confidence / maximum generated skill length |
| `relevantSkillLimit` / `maxManagedSkills` | `8` / `100` | Related skills in the prompt / automatic management capacity |
| `language` | `"zh-CN"` | Language of generated content |
| `model` | Task model | Optional `{ "providerID": "...", "id": "..." }` override |
| `providerAllowlist` | `[]` | When nonempty, allow only the listed providers |
| `excludeTools` / `excludeSessions` | `[]` / `[]` | Exclude specified tools and sessions |
| `excludeFiles` | Common sensitive paths | File-path globs; a custom array replaces the configured list, while built-in sensitive-file checks always apply |
| `sensitivePatterns` | `[]` | Literal sensitive fragments of at least 3 characters; not regular expressions |
| `storeEvidence` | `"redacted"` | Retain redacted evidence excerpts in provenance, or use `"none"` |
| `globalStateDirectory` | User-private state directory | Optional storage directory for cross-project budgets |

Daily budgets reset by UTC date. Input is estimated from content actually included in the prompt and reserved before each call. Failed attempts consume their reservation too. The current host generation API returns text without reliable actual usage, an output-token limit or enforced JSON schema. These settings therefore limit call counts and estimated input, not exact spend or total tokens. `doctor` reports observed capabilities.

To update a skill, the model must see its complete old body. If that body does not fit the current budget, the update is skipped to avoid losing existing steps. Deduplication combines retrieval of related skills, model judgment and ID/title/description checks.

## Move, enable, disable or uninstall

```powershell
node bin/autoskill.mjs install --project D:\your-project --dry-run
node bin/autoskill.mjs disable --project D:\your-project
node bin/autoskill.mjs enable --project D:\your-project
node bin/autoskill.mjs uninstall --project D:\your-project
node bin/autoskill.mjs install --global
```

Only an explicit `--global` changes the user's OpenCode configuration. It cannot be combined with `--project` or `--config`. Global installation still writes skills into each task's project. If the plugin is enabled both globally and locally, inspect the configuration with `doctor` first.

After upgrading or moving the plugin, rerun `install` from the new package directory. It recognizes the package name, the old directory's package identity or an existing installation record, merges duplicates and preserves the first entry's options. If the old directory is gone and no installation record remains, specify the exact old reference from the configuration:

```powershell
node bin/autoskill.mjs install --project D:\your-project --replace D:/old/opencode-autoskill
```

`disable` and `uninstall` take effect after OpenCode reloads. Uninstallation removes the plugin configuration while preserving skills, drafts, historical versions and runtime records. It does not restore an entire old configuration file.

For installation, migration, sync and cleanup administration, `--dry-run` previews changes without calling the model or committing the corresponding changes. **Portable CLI `review --dry-run` and the OpenCode/MCP `autoskill_review` tool's `dryRun` do call the model, consume budget and save drafts; they only skip publishing the skill body.** Manage those drafts with `drafts inspect/publish/discard`.

## Development and validation

```powershell
npm test
npm run check
npm run evaluate
npm run smoke
npm run smoke:reuse
npm pack
npm run package-check -- .\opencode-autoskill-0.4.0.tgz
```

`npm test` covers configuration, candidate validation, task splitting, queue recovery, skill protection and CLI lifecycle. `smoke` starts an isolated real OpenCode service and a mock model listening only on localhost. It checks plugin loading, direct-tool and Code Mode evidence, background distillation, saving and refresh. It also terminates the CLI while a model response is pending, restarts the same project and checks persistent queue recovery, the second attempt and publication state. It uses temporary projects and an isolated HOME. Set `OPENCODE_BIN` to choose the CLI path.

`npm run smoke` does not rebuild implicitly: run `npm run build` after source changes. The mock model and client use Node's built-in APIs. A packaged installation can run `node scripts/smoke.mjs` without development dependencies.

`npm run smoke:reuse` uses real OpenCode and a local mock model to check reuse in later tasks: highly relevant bodies enter the main model context automatically; unknown prerequisites are verified before `autoskill_load`, application and verification; model reports remain distinct from user feedback; unrelated later tasks in the same session do not inherit earlier context. It also checks that the native managed-skill list can shrink while external user skills remain. The script is `scripts/reuse-smoke.mjs` and makes no extra reviewer-model call. Passing mock-model checks establishes the integration path only.

`package-check` installs the specified archive with fresh production dependencies, loads modules, exercises CLI installation/enable/disable/uninstall, runs offline evaluation and both real-host distillation and reuse smoke checks. Projects and configurations are isolated in temporary directories.

By default, `evaluate` runs candidate-validation examples, independently labeled complexity-screening replay and skill-retrieval routing replay without model calls. It reports these three groups separately. `reuse` reports candidate recall, incorrect/missed automatic loads, individual conditions and exclusion reasons. Retrieval metrics do not measure actual reuse success. You can replay real reviewer output or explicitly connect a reviewer endpoint; these options replace distillation decisions only, while reuse retrieval remains a local replay. See [evaluation formats and scope](evaluation/README.md).

A real CLI plus mock models validates integration. Real-model distillation quality still needs evaluation on actual tasks. The adapter uses SDK 2.2.7 types during development and does not load the SDK at runtime. Revalidate before upgrading the host. Dependency-audit results are those returned by the current `npm audit`.

Automatic loading depends on matching, known prerequisites, versions and budgets. Actual adoption and execution still depend on model judgment for the current task. The plugin does not guarantee that every complex task creates a file, and a loaded skill is not counted as a successful reuse.

Each model request is associated with a task revision through the user message ID and the hash of its original first text part. Attachment text appended by OpenCode is excluded from that hash. If another plugin rewrites the original first text part and exact association fails, additional reuse is skipped for that call while the main task proceeds. The load ledger means the plugin returned a body; it does not prove the provider received the request or the model used it.

This project is original code. Interface references: [OpenCode server plugin API](https://opencode.ai/docs/build/plugins/server/), [plugin loading](https://opencode.ai/docs/build/plugins/), and [Skills](https://opencode.ai/docs/skills/).
