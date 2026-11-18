# AutoSkill 跨平台使用说明

## 当前实现

当前实现增加共享核心、MCP stdio 服务、平台 hooks、独立 reviewer、持久任务证据、配置安装与迁移、原生技能导出。原来的 OpenCode 包名、插件导出和无 `--host` 命令继续兼容。

需要 Node.js >=22.18。适配器在本地执行，工作目录和技能库必须在执行环境可访问。远程或云端需要把包、配置及对应凭证环境变量部署到实际执行环境；本机安装不会自动完成远端部署。

| 平台 | 自动复用 | 自动采集/提炼 | 验证情况 |
|---|---|---|---|
| OpenCode | 原生 prompt/context hooks | 原生插件和宿主模型 | Windows 上 OpenCode 2.2.7 真实宿主 smoke 通过；模型为本机模拟服务 |
| Claude Code | UserPromptSubmit 附加上下文 | 工具 hooks、Stop、独立 reviewer | 标准化夹具、实际 hook 子进程、worker/MCP 闭环通过；未运行真实 Claude 客户端 |
| Codex | UserPromptSubmit 附加上下文 | 工具 hooks、Stop/Interrupt、独立 reviewer | 夹具和子进程/MCP 复用通过；未对实际 Codex 会话做完整验收 |
| Gemini CLI | BeforeAgent 本轮上下文 | BeforeTool/AfterTool/AfterAgent、独立 reviewer | 标准化与安装夹具通过；未运行真实客户端 |
| Cursor | sessionStart 提供工作流；首个 postToolUse 后可提供正文；也可 MCP 按需加载 | 工具 hooks、stop、独立 reviewer | 夹具和生成的 Windows launcher 实际执行通过；未运行真实客户端 |
| 通用 MCP | 模型主动 search/load | 仅复用；不能被动采集其他工具 | 真实 stdio JSON-RPC 初始化、工具调用与校验通过 |

平台的“声明能力”、检测到的版本、观测到的 hooks 和实际验收分开记录。安装成功不代表宿主已信任 hooks。`doctor --host ...` 的 `verified:false` 是静态诊断的边界，不冒充客户端验收结果。

## 安装

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

使用 npm 安装包时也可以直接调用 `autoskill`。`claude` 是 `claude-code` 的别名，`mcp` 是 `generic` 的别名。`--all` 安装全部适配器，也会安装原有 OpenCode 配置。通常只安装实际使用的平台。

安装器只增量写入自己管理的字段和 hooks；保留其他配置。已被人工改动的受管字段会阻止覆盖。Windows hook 使用显式 PowerShell encoded launcher，支持空格、中文、单引号和 shell 特殊字符；核心逻辑仍由 Node 执行。

`--package` 可以使用相对当前安装命令目录的路径；安装前会解析为绝对路径并验证入口。Codex 配置通过 TOML 解析器检查表名和冲突，保留原有文本格式。`install/uninstall/enable/disable --all` 会先预检所有平台；预检失败不会修改任何平台，执行阶段的异常会返回已完成的平台列表。`sync --all` 按平台依次执行，不提供全体预检或批量事务。

### 通用 MCP 客户端接入

`install --host generic` 生成项目的 `.autoskill/mcp.json`。把其中 `mcpServers.autoskill` 的 `command` 和完整 `args` 注册到目标客户端的 MCP stdio 服务配置，再按客户端要求重新加载。未知客户端不会自动读取这个项目自定义文件；配置位置和服务条目外层结构以该客户端为准。

生成配置使用 Node 和脚本的绝对路径，`args` 包含 `serve --host generic --project <项目绝对路径>`。保留实际安装目录；多个项目应分别注册或选择对应项目的服务。可以用以下命令确认服务入口能启动：

```powershell
node bin/autoskill.mjs serve --host generic --project D:\your-project
```

服务通过 stdin/stdout 使用 MCP JSON-RPC，手工启动后等待客户端输入是正常状态。连接后让客户端列出并调用 `autoskill_search`、`autoskill_load`；这条通用入口只提供按需复用。

### 查看实际状态和修复配置

管理命令默认返回 JSON，便于脚本调用；加 `--human` 查看简短摘要。hook/serve 使用宿主协议输出，不接受 `--human`。

```powershell
node bin/autoskill.mjs doctor --host cursor --human --project D:\your-project
node bin/autoskill.mjs status --host cursor --human --project D:\your-project
node bin/autoskill.mjs install --host cursor --dry-run --project D:\your-project
```

doctor 分别报告安装记录、实际配置是否完整、缺失或人工改动、最后观察到的宿主事件以及 `verified:false`。只有配置贡献实际匹配才显示已安装。完全缺失的受管贡献可通过重新 install 补齐；先用 `--dry-run` 检查计划。人工修改的贡献仍会阻止覆盖，doctor 给出具体位置和可用修复步骤。

status 的 `summary` 区分停用、通用 MCP 工具、只复用/等待 reviewer、复盘中、排队、等待宿主事件和就绪，并展示技能数量、待处理数、下次运行时间及最近原因。就绪表示本地链路状态，实际客户端验收仍单独记录。

```powershell
node bin/autoskill.mjs disable --host cursor --project D:\your-project
node bin/autoskill.mjs enable --host cursor --project D:\your-project
node bin/autoskill.mjs uninstall --host cursor --project D:\your-project
```

配置变更后需按宿主要求刷新或重新打开会话。卸载保留技能、来源、队列及反馈。模型或宿主管理策略仍决定工具权限，AutoSkill 不会因加载技能而执行命令或提升权限。

`.autoskill/config.json` 中的 `options.enabled:false` 是总停用开关：新 hook 不初始化采集链路，MCP 的 search/load/feedback/review 不再处理任务，不新增任务证据。已有记录保留，可另用 clean 清理。长驻服务在重新打开后读取配置变更；仅设置 `reuseEnabled:false` 则关闭复用，保留采集与提炼。

配置安装、迁移、同步与 clean 的 `--dry-run` 不提交对应变更、不调用模型。`review --dry-run` 是模型复盘预览：会调用所配置模型、消耗预算并落盘候选，不发布 Skill；工具 `autoskill_review` 的 `dryRun` 同样如此。

已有共享配置时，使用 `enable/disable --host opencode` 可同时同步原生配置和共享配置的启停状态。无 `--host` 的历史 OpenCode 命令保留原有配置修改行为，共享配置中的显式停用仍优先。

### 宿主接口依据

- Claude Code：[Hooks](https://code.claude.com/docs/en/hooks)、[MCP](https://code.claude.com/docs/en/mcp)、[Skills](https://code.claude.com/docs/en/skills)。transcript 可能异步落盘，因此实现采用工具事件，不扫描会话目录。
- Codex：[Hooks](https://learn.chatgpt.com/docs/hooks)、[Skills](https://learn.chatgpt.com/docs/build-skills)、[插件打包](https://developers.openai.com/plugins/build/plugins)。需要宿主支持并信任 hooks；当前带生命周期 hooks 的包采用本地分发，不能假定能进入公共插件目录。
- Gemini CLI：[Hooks](https://geminicli.com/docs/hooks/reference/)、[MCP](https://geminicli.com/docs/tools/mcp-server/)、[Skills](https://geminicli.com/docs/cli/skills/)。不依赖尽力执行的 SessionEnd；原生技能资源授权继续由 Gemini 控制。
- Cursor：[Hooks](https://cursor.com/docs/hooks)、[MCP](https://cursor.com/docs/mcp)、[Skills](https://cursor.com/docs/skills)。beforeSubmitPrompt 不承诺任务前任意上下文注入。云端 hooks 覆盖和结果脱敏需单独验证。
- [MCP tools 协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。MCP 不向本服务器自动提供整个会话或其他工具的调用记录。

## 配置复盘模型

安装会生成 `.autoskill/config.json`。凭证只通过环境变量引用，不写入项目配置。示例：

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

这里要求模型服务支持 Chat Completions、JSON object 输出，以及 `temperature`/`max_tokens` 参数。`baseUrl` 是 API 前缀，客户端追加 `/chat/completions`。远程 endpoint 必须 HTTPS；只允许 loopback HTTP 作为本地模型或模拟服务。未经配置不会调用外部付费模型。OpenCode 原生适配器继续使用其宿主模型接口。

```powershell
$env:AUTOSKILL_REVIEW_API_KEY = '<your-key>'
node bin/autoskill.mjs doctor --host codex --project D:\your-project
```

在启动宿主的环境中提供变量。插件不读取其他平台私有登录文件。未配置 reviewer 时，检索、加载和证据入队可用；自动复盘显示 `model_backend_unconfigured` 或 `model_credential_missing`，不会伪造完成结果。

默认使用既有项目/用户预算。若设置 `providerAllowlist`，便携 reviewer 使用 provider ID `autoskill-reviewer`，须包含该 ID。

`capabilities` 是安装者对宿主工具可用性的显式声明，默认空列表，不授予权限。例如技能要求 `browser` 时，未声明该能力的宿主不会自动加载；声明前应核对实际宿主工具与权限。

## 共享技能和原生导出

```text
.autoskill/
├─ config.json                    可共享配置，无凭证
├─ skills/<id>/SKILL.md            权威正文，可提交 Git
├─ runtime/                       私有 evidence、队列、反馈和来源
├─ config-backups/                私有配置备份
├─ installations/                 受管字段与安装身份
└─ exports/                       原生导出哈希清单
```

私有目录带忽略规则。技能不会包含完整来源证据。多个平台在同一工作区共用技能和反馈，但任务及 worker 按 host/workspace 隔离。

默认通过 hooks/MCP 路由技能。需要宿主原生发现时显式导出：

```powershell
node bin/autoskill.mjs sync --host codex --project D:\your-project --dry-run
node bin/autoskill.mjs sync --host codex --project D:\your-project
```

导出目标：Claude `.claude/skills`，Codex `.agents/skills`，Gemini `.gemini/skills`，Cursor `.cursor/skills`，OpenCode `.opencode/skills`。受管来源及正文哈希必须一致；已人工修改的副本列为冲突，不覆盖。`--prune` 只清理导出清单内、仍符合哈希的过时副本。宿主可能同时发现多个目录，避免手动再复制同名技能；OpenCode 适配器会校验并关联受管导出别名。

技能的可选兼容声明记录在 `metadata.autoskill-compatibility` 中：

```yaml
metadata:
  autoskill: true
  autoskill-compatibility:
    hosts: [opencode]
    requiredCapabilities: [terminal]
```

指定宿主或能力限制时，自动检索、显式加载和原生导出都要重新检查；重新执行 sync 发现能力被撤销时，未被人工修改的受管导出会撤回，无需额外指定 `--prune`。离线 OpenCode sync 不推断宿主运行时 API 能力，应显式声明所需能力。旧版无兼容元数据的技能继续按环境/前提检查，不能据此断言正文在所有平台可执行。涉及明确 OpenCode 原生插件 API 的新候选会保守限制为 OpenCode。

原生导出会先写入私有事务计划，再提交文件及所有权清单。同步中断后重新执行同一 sync 会按 hash 恢复，期间人工修改的副本继续受保护；`--dry-run` 只显示恢复计划。不要删除 `.autoskill/exports` 内的 pending 事务文件，否则会失去部分导出的恢复依据。

新同步操作使用随进程退出释放的 SQLite 锁，因此被强制结束后也可重试恢复。若升级时留下旧版本的文件操作锁，程序会保留并明确诊断；需先停止旧版本宿主并检查旧锁，不能直接删除整个私有运行目录。

## 旧项目迁移

旧项目不需要迁移就可继续使用 OpenCode。首次安装其他平台时，如果检测到 `.opencode` 下已有技能或运行数据，会要求先执行迁移，避免新目录遮蔽旧数据。

**迁移前停止所有宿主进程。** 活动锁、队列与 SQLite 写锁可以检测，但空闲旧进程不一定有租约，无法据此证明全部退出。

```powershell
node bin/autoskill.mjs migrate --project D:\your-project --dry-run
node bin/autoskill.mjs migrate --project D:\your-project
```

迁移使用 SQLite backup 纳入 WAL 内容、完整性校验和哈希检查，在最后写入布局标记。待处理/运行/重试队列会阻止迁移。旧文件保留；手写技能不因复制变成受管技能；已知旧 SOURCE.json 移到私有来源目录。

```powershell
node bin/autoskill.mjs migrate --rollback --project D:\your-project --dry-run
node bin/autoskill.mjs migrate --rollback --project D:\your-project
```

自动回退仅适用于新配置与数据尚未变更的情况，且保留新目录快照。已经继续工作后，哈希检查会拒绝自动回退以保护新增数据。

## MCP 和任务关联

提供五个工具：`autoskill_search`、`autoskill_load`、`autoskill_feedback`、`autoskill_status`、`autoskill_review`。

任务钩子或 search 响应返回 `contextToken`。load、feedback、review 必须携带本任务 token。未提供 token 的 search 建立独立 MCP 查询，不能借此声明已经观测到宿主任务成功。模型不能向 review 提交自编工具证据，也不能把 feedback 标成用户评价。

显式 MCP 查询 token 在 **24 小时未使用**后失效；有效 token 的使用会延长空闲期限。过期只停止访问，查询原文由 clean 物理清理：即使指定 30 天，已过期查询也会删除；指定更短的 `--older-than` 可主动清理较新的显式查询。宿主任务的待处理证据仍受保护。

新消息、修订、排队轮次与多个平台分别关联；无法确定归属的迟到事件会跳过。输入被截断时不自动加载/提炼。未结束工具保持 pending。停止事件仅提供执行边界，是否完成任务仍由独立验证证据及 reviewer 校验决定。

当前任务指针与后台记账时间独立；稳定 start 在全历史中去重，已清理任务只保留不含提示原文的 ID 防止重放。补充搜索的匹配准入事实会恢复，原始查询文字不进入复用账本；重启后仍重新检查原任务排除、正文 hash、环境和权限限制。

## 子智能体

- `root-only`：默认只处理主任务。
- `inherit`：Claude/Codex 在受支持的 SubagentStart 响应中继承父任务的受限技能上下文；不为子任务重复发布。其他宿主不承诺无接口支持的注入。
- `independent`：核心 SDK 和 OpenCode 原生适配器提供策略入口。便携 hooks 仍排除子智能体的独立发布，因为缺少统一、可靠的子任务 prompt/身份；doctor 会报告这一限制。

## 队列、后台进程和清理

完成 hook 先持久采集证据，再在 reviewer 可用时启动隐藏 worker。短事务领取任务，模型调用不占数据库事务；不同进程通过队列租约与正文 CAS 协调。Windows 启动使用隐藏进程。worker 按时间片退出，未完成队列保留；长驻 MCP 进程也能处理所属平台队列。

hook 从运行入口开始共用 2 秒处理预算，覆盖输入、初始化、数据库锁等待和复用；进程启动另有开销。超时返回空的可选响应，让宿主继续。已落盘的完成边界仍会安排独立 worker 接管；短暂失败的重试在 worker 时间片内继续等待，超出时间片的预算/重试等待由下一次 worker 或长驻 MCP 恢复。

```powershell
node bin/autoskill.mjs worker --host claude-code --project D:\your-project
node bin/autoskill.mjs status --host claude-code --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --dry-run --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --project D:\your-project
```

没有安装系统级守护服务。关闭宿主后，独立 worker 可以完成当前时间片；超时/延迟重试任务下次启动恢复。`clean` 清理终结任务证据，保留技能所有权与版本记录；便携事件库中未处理任务保持保留。

## 开发和验证

```powershell
npm run check
npm test
npm run smoke
npm run smoke:reuse
npm run smoke:portable
npm pack --pack-destination artifacts
npm run package-check -- .\artifacts\opencode-autoskill-0.4.0.tgz
```

`smoke:portable` 使用临时项目、真实 hook CLI/worker/MCP 子进程和本机模拟 reviewer，验证 Claude → Codex 的保存、复用与反馈；不使用外部凭证。它验证集成链路，不代表真实客户端、真实模型质量或跨操作系统验收。

已交付接口：`opencode-autoskill/core`、`opencode-autoskill/adapters`、`opencode-autoskill/portable`。OpenCode 默认入口仍为 `opencode-autoskill`。后续增加宿主时，实现标准化事件、能力声明、配置安装及宿主夹具即可复用核心。

本轮未交付云端技能同步服务、任意平台 headless reviewer 或 Codex App Server 专用客户端；当前 Codex 走 hooks/MCP，复盘走显式 OpenAI-compatible 后端。这些不是当前适配器的隐藏依赖。
