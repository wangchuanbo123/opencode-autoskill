# AutoSkill Cross-Platform Guide

## Current implementation

The cross-platform implementation provides a shared core, an MCP stdio server, platform hooks, an independent reviewer, durable task evidence, configuration installation and migration, and native skill exports. The existing OpenCode package name, plugin exports, and commands without `--host` remain compatible.

Node.js >=22.18 is required. Adapters run locally, and the working directory and skill library must be accessible in the execution environment. For remote or cloud execution, deploy the package, configuration, and required credential environment variables to that environment. A local installation does not deploy them remotely.

| Platform | Automatic reuse | Automatic capture and distillation | Verification |
|---|---|---|---|
| OpenCode | Native prompt/context hooks | Native plugin and host model | Real OpenCode 2.2.7 host smoke tests passed on Windows with a local mock model service |
| Claude Code | Additional context through UserPromptSubmit | Tool hooks, Stop, and an independent reviewer | Normalization fixtures, actual hook subprocesses, and the worker/MCP integration passed; the native Claude client was not tested |
| Codex | Additional context through UserPromptSubmit | Tool hooks, Stop/Interrupt, and an independent reviewer | Fixtures and subprocess/MCP reuse passed; a complete native Codex session was not tested |
| Gemini CLI | Context for the current turn through BeforeAgent | BeforeTool/AfterTool/AfterAgent and an independent reviewer | Normalization and installation fixtures passed; the native client was not tested |
| Cursor | Workflow guidance through sessionStart; skill bodies can be provided after the first postToolUse; MCP loading is also available on demand | Tool hooks, stop, and an independent reviewer | Fixtures and generated Windows launchers passed actual execution checks; the native client was not tested |
| Generic MCP | The model explicitly calls search/load | Reuse only; cannot passively capture other tools | Actual stdio JSON-RPC initialization, tool calls, and validation passed |

Declared platform capabilities, detected versions, observed hooks, and completed acceptance tests are recorded separately. Successful installation does not mean the host has trusted the hooks. The `verified:false` field from `doctor --host ...` marks the limits of static diagnostics; it does not claim native-client acceptance.

## Installation

```powershell
git clone https://github.com/wangchuanbo123/opencode-autoskill.git
cd opencode-autoskill
npm ci
npm run build

node bin/autoskill.mjs install --host claude-code --project D:\your-project
node bin/autoskill.mjs install --host codex --project D:\your-project
node bin/autoskill.mjs install --host gemini --project D:\your-project
node bin/autoskill.mjs install --host cursor --project D:\your-project
node bin/autoskill.mjs install --host generic --project D:\your-project
node bin/autoskill.mjs doctor --all --project D:\your-project
```

When installing the package through npm, you can also invoke `autoskill` directly. `claude` is an alias for `claude-code`, and `mcp` is an alias for `generic`. `--all` installs every adapter, including the existing OpenCode configuration. Usually, install only the platforms you use.

The installer adds only the fields and hooks it manages, preserving other configuration. It refuses to overwrite managed fields that have been edited manually. Windows hooks use an explicit PowerShell encoded launcher that supports spaces, Chinese characters, single quotes, and shell metacharacters. The core logic still runs in Node.

`--package` accepts a path relative to the installation command's current directory. The installer resolves it to an absolute path and validates the entry point before installation. Codex configuration uses a TOML parser to check table names and conflicts while preserving the original text format. `install/uninstall/enable/disable --all` preflights every platform before making changes. A failed preflight leaves all platforms unchanged; an error during execution returns the list of platforms already completed. `sync --all` runs one platform at a time and does not provide a full preflight or a batch transaction.

### Connect a generic MCP client

`install --host generic` generates `.autoskill/mcp.json` in the project. Register the `command` and complete `args` from `mcpServers.autoskill` in the target client's MCP stdio server configuration, then reload as required by that client. An unknown client will not automatically read this project-specific file. The configuration location and outer server-entry structure depend on the client.

The generated configuration uses absolute paths for Node and the script. Its `args` include `serve --host generic --project <absolute-project-path>`. Keep the actual installation directory available. For multiple projects, register separate services or select the service for the relevant project. To check that the server entry point starts:

```powershell
node bin/autoskill.mjs serve --host generic --project D:\your-project
```

The server uses MCP JSON-RPC over stdin/stdout. Waiting for client input after a manual launch is normal. Once connected, have the client list and call `autoskill_search` and `autoskill_load`. This generic entry point provides reuse on demand only.

### Inspect status and repair configuration

Management commands return JSON by default for scripting. Add `--human` for a brief summary. hook/serve use the host protocol for output and do not accept `--human`.

```powershell
node bin/autoskill.mjs doctor --host cursor --human --project D:\your-project
node bin/autoskill.mjs status --host cursor --human --project D:\your-project
node bin/autoskill.mjs install --host cursor --dry-run --project D:\your-project
```

doctor reports the installation record, whether the actual configuration is complete, missing entries or manual edits, the last observed host event, and `verified:false`. It reports an installation as present only when the actual configuration contributions match. Completely missing managed contributions can be restored by running install again; use `--dry-run` to inspect the plan first. Manually edited contributions remain protected from overwriting. doctor identifies their locations and available repair steps.

The `summary` in status distinguishes disabled operation, generic MCP tools, reuse only/waiting for a reviewer, review in progress, queued work, waiting for host events, and readiness. It also shows the skill count, pending count, next run time, and most recent reason. Readiness describes the local processing state; native-client acceptance is recorded separately.

```powershell
node bin/autoskill.mjs disable --host cursor --project D:\your-project
node bin/autoskill.mjs enable --host cursor --project D:\your-project
node bin/autoskill.mjs uninstall --host cursor --project D:\your-project
```

After changing configuration, refresh or reopen the session as required by the host. Uninstalling preserves skills, provenance, the queue, and feedback. Tool permissions remain subject to model or host policy. Loading a skill does not cause AutoSkill to execute commands or elevate permissions.

`options.enabled:false` in `.autoskill/config.json` disables all operation: new hooks do not initialize capture, MCP search/load/feedback/review no longer process tasks, and no new task evidence is stored. Existing records remain and can be removed separately with clean. Long-running services read configuration changes when reopened. Setting only `reuseEnabled:false` disables reuse while retaining capture and distillation.

For configuration installation, migration, synchronization, and clean, `--dry-run` does not commit the corresponding changes or call a model. `review --dry-run` previews a model review: it calls the configured model, consumes budget, and persists a candidate without publishing a Skill. The `dryRun` option of the `autoskill_review` tool has the same behavior.

When shared configuration already exists, `enable/disable --host opencode` synchronizes enabled state in both the native and shared configurations. Legacy OpenCode commands without `--host` retain their original configuration behavior. An explicit disable in the shared configuration still takes precedence.

### Host interface references

- Claude Code: [Hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), and [Skills](https://code.claude.com/docs/en/skills). Transcripts may be persisted asynchronously, so this implementation uses tool events rather than scanning session directories.
- Codex: [Hooks](https://learn.chatgpt.com/docs/hooks), [Skills](https://learn.chatgpt.com/docs/build-skills), and [plugin packaging](https://developers.openai.com/plugins/build/plugins). The host must support and trust hooks. Packages with lifecycle hooks currently use local distribution; availability in a public plugin directory cannot be assumed.
- Gemini CLI: [Hooks](https://geminicli.com/docs/hooks/reference/), [MCP](https://geminicli.com/docs/tools/mcp-server/), and [Skills](https://geminicli.com/docs/cli/skills/). The implementation does not depend on best-effort SessionEnd execution. Gemini continues to control authorization for native skill resources.
- Cursor: [Hooks](https://cursor.com/docs/hooks), [MCP](https://cursor.com/docs/mcp), and [Skills](https://cursor.com/docs/skills). beforeSubmitPrompt does not guarantee arbitrary context injection before a task. Cloud hook coverage and result redaction require separate verification.
- [MCP tools protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). MCP does not automatically expose the entire session or other tools' call records to this server.

## Configure the reviewer

Installation generates `.autoskill/config.json`. Credentials are referenced through environment variables only and are not written to project configuration. Example:

```json
{
  "schemaVersion": 1,
  "adapters": {
    "claude-code": { "enabled": true, "mode": "hooks", "capabilities": ["terminal", "filesystem"] },
    "codex": { "enabled": true, "mode": "hooks", "capabilities": ["terminal", "filesystem"] }
  },
  "options": { "maxReviewsPerDay": 20, "reuseCandidateLimit": 5, "reuseAutoLoadLimit": 2 },
  "reviewer": {
    "type": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "your-chat-completions-compatible-model",
    "apiKeyEnv": "AUTOSKILL_REVIEW_API_KEY",
    "maxOutputTokens": 8192
  },
  "agentPolicy": "root-only"
}
```

The model service must support Chat Completions, JSON object output, and the `temperature`/`max_tokens` parameters. `baseUrl` is the API prefix; the client appends `/chat/completions`. Remote endpoints must use HTTPS. HTTP is allowed only on loopback for local models or mock services. No external paid model is called unless configured. The native OpenCode adapter continues to use its host model interface.

```powershell
$env:AUTOSKILL_REVIEW_API_KEY = '<your-key>'
node bin/autoskill.mjs doctor --host codex --project D:\your-project
```

Provide the variable in the environment that launches the host. The plugin does not read other platforms' private login files. Without a configured reviewer, retrieval, loading, and evidence queuing remain available. Automatic review reports `model_backend_unconfigured` or `model_credential_missing` rather than inventing a completed result.

Existing project/user budgets apply by default. If you set `providerAllowlist`, include the portable reviewer's provider ID, `autoskill-reviewer`.

`capabilities` is an explicit declaration by the installer of the host's available tools. It defaults to an empty list and does not grant permissions. For example, a host that has not declared `browser` will not automatically load a skill requiring it. Check the actual host tools and permissions before declaring a capability.

## Shared skills and native exports

```text
.autoskill/
├─ config.json                    Shareable configuration, no credentials
├─ skills/<id>/SKILL.md            Canonical skill body; can be committed to Git
├─ runtime/                       Private evidence, queue, feedback, and provenance
├─ config-backups/                Private configuration backups
├─ installations/                 Managed fields and installation identity
└─ exports/                       Hash manifests for native exports
```

Private directories have ignore rules. Skills do not contain their full source evidence. Platforms in the same workspace share skills and feedback, while tasks and workers are isolated by host/workspace.

Skills are routed through hooks/MCP by default. Export explicitly when native host discovery is needed:

```powershell
node bin/autoskill.mjs sync --host codex --project D:\your-project --dry-run
node bin/autoskill.mjs sync --host codex --project D:\your-project
```

Export destinations are Claude `.claude/skills`, Codex `.agents/skills`, Gemini `.gemini/skills`, Cursor `.cursor/skills`, and OpenCode `.opencode/skills`. Managed provenance and body hashes must match. Manually edited copies are listed as conflicts and are not overwritten. `--prune` removes only obsolete copies that are in the export manifest and still match their hashes. Hosts may discover multiple directories, so avoid manually duplicating skills with the same name. The OpenCode adapter validates and associates managed export aliases.

Optional skill compatibility declarations are stored in `metadata.autoskill-compatibility`:

```yaml
metadata:
  autoskill: true
  autoskill-compatibility:
    hosts: [opencode]
    requiredCapabilities: [terminal]
```

When host or capability restrictions are specified, automatic retrieval, explicit loading, and native exports all recheck them. If a subsequent sync finds that a capability has been revoked, unchanged managed exports are withdrawn without requiring `--prune`. Offline OpenCode sync does not infer runtime host API capabilities; declare required capabilities explicitly. Skills without compatibility metadata continue to be checked against their environment and prerequisites. This does not establish that their bodies are executable on every platform. New candidates that explicitly use native OpenCode plugin APIs are conservatively restricted to OpenCode.

Native export writes a private transaction plan before committing files and the ownership manifest. After an interrupted synchronization, rerun the same sync to recover by hash. Copies edited manually in the meantime remain protected. `--dry-run` only displays the recovery plan. Do not delete pending transaction files in `.autoskill/exports`; they are needed to recover partial exports.

New synchronization operations use a SQLite lock that is released when the process exits, allowing recovery after a forced termination. If an upgrade leaves a file-operation lock from an older version, the program preserves it and reports it explicitly. Stop the old host and inspect the old lock first; do not delete the entire private runtime directory.

## Migrate an existing project

Existing projects can continue using OpenCode without migration. When installing another platform for the first time, existing skills or runtime data under `.opencode` require migration first so the new layout does not hide old data.

**Stop all host processes before migration.** Active locks, queues, and SQLite write locks can be detected, but an idle old process may not hold a lease. Their absence does not prove that every process has exited.

```powershell
node bin/autoskill.mjs migrate --project D:\your-project --dry-run
node bin/autoskill.mjs migrate --project D:\your-project
```

Migration uses SQLite backup to include WAL contents, integrity validation, and hash checks. It writes the layout marker last. Pending/running/retry queue entries prevent migration. Old files are retained. Handwritten skills do not become managed merely because they are copied. Known legacy SOURCE.json files move to the private provenance directory.

```powershell
node bin/autoskill.mjs migrate --rollback --project D:\your-project --dry-run
node bin/autoskill.mjs migrate --rollback --project D:\your-project
```

Automatic rollback is available only while the new configuration and data remain unchanged, and it preserves a snapshot of the new directories. After further work, hash checks refuse automatic rollback to protect newly added data.

## MCP and task association

Five tools are available: `autoskill_search`, `autoskill_load`, `autoskill_feedback`, `autoskill_status`, and `autoskill_review`.

Task hooks or search responses return a `contextToken`. load, feedback, and review require the token for the current task. A search without a token creates an independent MCP query; it cannot assert that a successful host task was observed. The model cannot submit fabricated tool evidence to review or label feedback as a user evaluation.

Explicit MCP query tokens expire after **24 hours of inactivity**. Using a valid token extends its idle deadline. Expiration only prevents access; clean physically removes the query text. Expired queries are removed even when 30 days is specified, while a shorter `--older-than` can proactively remove newer explicit queries. Pending host-task evidence remains protected.

New messages, revisions, queued turns, and platforms are associated separately. Late events are skipped when ownership cannot be determined. Truncated input does not trigger automatic loading or distillation. Unfinished tools remain pending. A stop event supplies only an execution boundary; independent verification evidence and reviewer validation still determine whether the task is complete.

The current-task pointer is independent of background bookkeeping time. Stable start events are deduplicated across all history. Cleaned tasks retain only IDs without prompt text to prevent replay. Supplemental search admission is restored, while original query text stays out of the reuse ledger. After restart, the original task exclusions, body hash, environment, and permission constraints are rechecked.

## Subagents

- `root-only`: process only the main task by default.
- `inherit`: Claude/Codex inherit bounded skill context from the parent task in supported SubagentStart responses, without duplicate publication for the subtask. No context injection is promised for hosts without the required interface.
- `independent`: the core SDK and native OpenCode adapter expose this policy. Portable hooks still exclude independent subagent publication because a consistent, reliable subtask prompt/identity is unavailable. doctor reports this limitation.

## Queues, background processes, and cleanup

Completion hooks persist evidence before starting a hidden worker when a reviewer is available. Short transactions claim tasks; model calls do not hold database transactions. Processes coordinate through queue leases and body compare-and-swap (CAS) checks. Windows workers start as hidden processes. Workers exit after a time slice, retaining unfinished queue entries. A long-running MCP process can also handle its platform's queue.

Hooks share a 2-second processing budget from the runtime entry point, covering input, initialization, database lock waits, and reuse. Process startup adds separate overhead. A timeout returns an empty optional response so the host can continue. A durably stored completion boundary still schedules an independent worker to take over. Transient retries continue waiting within the worker's time slice. Budget or retry waits beyond that slice resume in the next worker or a long-running MCP process.

```powershell
node bin/autoskill.mjs worker --host claude-code --project D:\your-project
node bin/autoskill.mjs status --host claude-code --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --dry-run --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --project D:\your-project
```

No system daemon is installed. After the host closes, an independent worker can finish its current time slice. Tasks waiting on a timeout or delayed retry resume at the next launch. `clean` removes evidence for terminal tasks while retaining skill ownership and version records. Unprocessed tasks in the portable event store remain retained.

## Development and verification

```powershell
npm run check
npm test
npm run smoke
npm run smoke:reuse
npm run smoke:portable
npm pack --pack-destination artifacts
npm run package-check -- .\artifacts\opencode-autoskill-0.4.0.tgz
```

`smoke:portable` uses temporary projects, actual hook CLI/worker/MCP subprocesses, and a local mock reviewer to verify Claude → Codex saving, reuse, and feedback without external credentials. It verifies the integration, not native-client acceptance, real model quality, or compatibility across operating systems.

Available interfaces are `opencode-autoskill/core`, `opencode-autoskill/adapters`, and `opencode-autoskill/portable`. The default OpenCode entry point remains `opencode-autoskill`. Additional hosts can reuse the core by implementing normalized events, capability declarations, configuration installation, and host fixtures.

Cloud skill synchronization, arbitrary-platform headless reviewers, and a dedicated Codex App Server client are not included. Codex currently uses hooks/MCP, and reviews use an explicitly configured OpenAI-compatible backend. These are not hidden dependencies of the current adapters.
