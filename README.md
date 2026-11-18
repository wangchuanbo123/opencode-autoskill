# OpenCode AutoSkill

现在提供 **Claude Code、Codex、Gemini CLI、Cursor 和通用 MCP** 的本地适配器。共享技能库、平台 hooks、独立复盘模型、迁移与原生导出见 [跨平台使用说明](CROSS_PLATFORM.md)。原有 OpenCode 安装方式继续兼容；其他平台的实际能力及验收范围在该文档中分别列明。

在你照常使用 OpenCode 时，自动复盘复杂任务，把有验证证据、可以再次使用的方法保存为项目 Skill；后续任务开始时检索相关经验，在适用条件明确时自动加载。插件覆盖“沉淀 → 匹配 → 加载 → 使用 → 反馈”的链路。

v0.4 的适配目标为 **OpenCode 2.2.7**，需要 **Node.js ≥22.18**。默认自动运行，无需每次确认或输入 `/learn`。复用通过插件接口接入，不要求修改 OpenCode 源码。

## 快速开始

按使用的平台选择入口：

| 平台 | 安装与诊断 |
|---|---|
| OpenCode | 按下方快速开始安装，使用宿主已配置的模型 |
| Claude Code / Codex / Gemini CLI / Cursor | [跨平台安装](CROSS_PLATFORM.md#安装)，自动提炼还需[配置复盘模型](CROSS_PLATFORM.md#配置复盘模型) |
| 其他支持 MCP 的智能体 | 安装 `--host generic`，将生成的服务条目注册到客户端，使用 search/load 按需复用，见[接入步骤](CROSS_PLATFORM.md#通用-mcp-客户端接入) |

OpenCode 中应已配置可用的模型。从源码安装：

```powershell
cd D:\MyCode\opencode-autoskill
npm ci
npm run build
node bin/autoskill.mjs install --project D:\your-project
node bin/autoskill.mjs doctor --project D:\your-project
```

重新加载 OpenCode，然后正常执行任务。需要查看结果时：

```powershell
node bin/autoskill.mjs status --runtime --project D:\your-project
node bin/autoskill.mjs skills list --project D:\your-project
```

安装器修改项目根目录的 `opencode.jsonc`，已有 `opencode.json` 时使用它。保留注释、其他插件及配置。两个文件同时存在时，用 `--config D:\your-project\opencode.jsonc` 选择；同时提供的 `--project` 必须是该文件所在目录。

插件路径写为当前安装包的绝对目录，该目录需要保留。通过 npm 安装打包产物后，也可用 `opencode-autoskill` 代替 `node bin/autoskill.mjs`：

```powershell
npm install --prefix D:\plugins\autoskill-host D:\downloads\opencode-autoskill-0.4.0.tgz
node D:\plugins\autoskill-host\node_modules\opencode-autoskill\bin\autoskill.mjs install --project D:\your-project
```

直接解压 `.tgz` 时，还需在解压的 `package/` 目录执行 `npm install --omit=dev --ignore-scripts`，安装运行依赖。

## 自动复用怎样工作

```text
新用户任务开始
  → 从当前项目检索仍由插件管理的技能
  → 检查内容哈希、适用前提、技术栈、版本、时效和反馈
  → 排序、去重，保留最多 5 个候选摘要
  → 对高相关且前提明确的候选，自动加载最多 2 个完整技能
  → 其余候选由主模型判断，必要时通过 autoskill_load 加载
  → 模型结合本次任务使用方法并验证结果
  → 记录加载、模型报告、任务结果及用户反馈
```

每个新任务都会尝试本地检索，不另开一次模型请求进行匹配。按用户消息 ID 关联候选和本次加载，防止把上一个任务的匹配结果套用到新的请求。任务没有相关技能时照常执行；检索失败或超时不会阻止主任务。

OpenCode 复用失败日志提供 `hook` 阶段、固定 `reason` 类别和 `elapsedMs` 耗时，帮助区分超时、锁竞争和文件访问问题；日志不包含异常原文、任务文字或文件路径。

宿主接入使用 `session.hook("prompt")` 在用户输入接收时准备检索，使用 `session.hook("context")` 在主模型调用前为当前用户消息重建复用上下文；排队的新输入也有独立任务关联。插件不改写用户消息或显式技能附件，复用上下文随主任务提供；子会话和不在当前项目范围内的任务不进入这条自动链路。

### 如何控制技能过多和选错？

本地检索结合任务中的具体主题、技能标题/适用场景，以及观测到的项目环境。泛化的“修复、检查、运行测试”不能单独触发某个领域技能；中文技术术语参与检索。当前实现使用关键词、有限技术术语映射和明确条件检查，不使用向量数据库，也不宣称能识别所有语义等价问题。

候选摘要与完整正文分别控制数量和字符预算。默认最多 **5 个候选、2 个完整技能**；只选中后才把正文加入本次任务上下文，避免把全部正文发送给模型。候选摘要只包含标题、描述、评分及原因，状态记录保留技能哈希与版本以便核对。

`reuseAutoLoadLimit` 可设为 `0～2`，控制自动加载数量；单个任务含显式选择在内总共最多加载 2 个技能。默认单个技能正文不超过 6000 字符、整个复用上下文不超过 16000 字符。放不下完整步骤和验证的技能仅保留摘要，不把正文截到一半后提供给模型。

以下情况会排除自动复用：归档、归属哈希不匹配、人工修改、明确环境/运行版本不适配、过期、连续负反馈、敏感内容或不完整正文。默认超过 **180 天**的旧版本不进入本轮候选；这表示需要重新核验，不会因此删除文件。固定 `pin` 的技能仍可复用；固定仅保护其更新和清理。

只有明确满足的前提才支持自动加载。无法从当前项目证实的前提会把候选降为“需判断”，例如技能要求可复现的故障夹具，而当前仅在任务描述里提到它。已知前端框架、运行时版本或平台冲突会排除候选。环境识别和文本条件解析仍有边界，主模型应在执行前检查实际约束。

项目环境探测只读取受限大小的项目清单和已知标记文件，不运行探测命令、不扫描用户目录。插件自身运行时版本不会自动当作项目子进程的版本；无法证实版本要求时，候选交给模型进一步核实。

重复方法只保留一个候选；相近主题但方法存在冲突时，降低为需要模型判断的候选，避免同时自动加载互斥步骤。历史成功反馈只参与小幅排序，不能让无关技能越过匹配或环境门槛。这里的评分是路由启发式，**不是技能适用概率或成功率**。

### 自动加载与实际使用

高相关且条件明确时，插件会把完整技能作为本次任务的参考上下文并要求优先采用。用户当前要求、项目限制和权限继续生效；用户明确不使用技能时退出自动复用，针对某个主题的排除只影响该主题。

插件不会在加载时直接运行 Skill 中的命令。完整加载只证明内容已提供给模型；模型是否实际采用、方法是否造成任务成功，需要结合使用报告、执行证据及用户反馈判断。主模型仍可因新的事实发现技能不适用，并说明原因。

当前自动复用只针对**内容哈希与私有来源一致的插件生成技能**。已有手写、外部和人工修改的技能保留其原生发现方式；插件不改写这些正文，也不把它们纳入自动管理。若需要重新接管人工修改后的技能，先检查正文再显式 `skills adopt`。

### 反馈与治理

加载次数、模型自报是否使用、任务的成功/失败/中断结果，以及用户显式反馈分别记录。任务成功与技能有效之间没有必然因果关系；模型的 `autoskill_feedback` 是使用报告，不冒充用户评价。

反馈用于降低低价值候选的排序或停止其自动推荐。已有 `skills pin/archive/restore/rollback/prune` 可管理技能和保留版本；相近方法的自动检索去重不会直接重写或合并正文。重新提炼时仍需通过已验证改进、所有权和版本检查。

查看复用状态、按版本统计和任务关联信息：

```powershell
node bin/autoskill.mjs reuse status --project D:\your-project
node bin/autoskill.mjs reuse history --project D:\your-project
node bin/autoskill.mjs reuse history <skill-id> --project D:\your-project
```

用户对一次实际使用记录反馈时，指定状态中对应的会话和用户消息 ID：

```powershell
node bin/autoskill.mjs reuse feedback <skill-id> --session <session-id> --task <user-message-id> --outcome success --project D:\your-project
```

`--outcome` 支持 `success`、`failure`、`unknown`。反馈标为 `source: "user"`，关联当时实际加载的技能哈希；改版前的反馈不会算到新版正文。对同一用户消息的编辑产生多个检索版本时，可用 `--query-hash <hash>` 精确选择。模型工具不能写入用户来源的评价。

旧 `skills feedback` 仍可记录技能总体反馈，并保留当前正文版本的反馈供检索参考。新任务级 `reuse feedback` 写入独立账本，不再同时累加旧计数，避免一次评价被计算两次。

治理默认只输出建议，可先预览：

```powershell
node bin/autoskill.mjs reuse govern --project D:\your-project
node bin/autoskill.mjs reuse govern --apply --dry-run --project D:\your-project
node bin/autoskill.mjs reuse govern --apply --project D:\your-project
```

治理建议基于当前版本的用户反馈和时效；不会把模型自报或任务失败直接当成技能失败。应用归档前再次核对受管归属、内容哈希和固定状态，归档后仍可 `skills restore`。重复覆盖只给出保留主技能的建议，当前不会自动改写、拼接或合并正文。

## 自动提炼怎样工作

```text
OpenCode 完成一轮执行
  → 按用户任务边界切分，保留尚未处理的证据
  → 保存经过排除、脱敏和截断的任务证据，加入持久队列
  → 根据依赖、诊断、协调与独立核验等证据初筛
  → 预留项目和用户级调用预算，选择相关的已有 Skills
  → 模型分别评估实质复杂性与方法的沉淀价值
  → 检查完成状态、结构化评估、质量和证据引用
  → 自动新建/更新 SKILL.md，或保存为候选
  → 刷新技能列表，记录决定和原因
```

单个任务即可生成 Skill，是否送审与是否发布分别判断。v0.3 移除了“8 次调用，或 4 次且失败过就入选”的通道。读取很多文件、重复相同命令、拼写错误后重试，以及批量执行相同替换，都不能仅凭次数被认定为复杂任务。

### 如何界定复杂与值得沉淀？

| 判断层 | 看什么 | 不足以作为依据的信号 |
|---|---|---|
| 确定性初筛：是否值得花一次模型调用 | 工具证据中的非机械步骤依赖、诊断与方法调整、有关联的跨资源协调、调查结论与独立核验；必须完成并有足够有效证据 | 调用数、文件数、失败数、用户说“复杂”、助手声称已完成 |
| 模型评估复杂性 | 解释哪里需要判断、为什么步骤相互依赖或原方法失败，并引用实际工具证据 | 重复列举操作，或只复述分数与工具名 |
| 模型评估沉淀价值 | 可迁移的触发条件、可执行且有验证的方法、对已有技能的新增覆盖 | 内容很长、一次性项目细节、自报高置信度、与已有技能重复 |

初筛对相同操作去重。Code Mode 会分析内部操作，但单纯堆叠 `await read(...)` 不会获得实质复杂性。两次工具调用如果包含具体根因诊断和独立回归验证，也可能进入模型复盘。复杂的只读调查可通过独立来源核验入选。多任务会话仍按任务边界处理。

当前初筛策略为 `evidence-v1`。必须有至少两条去重后的有效成功工具证据，以及后续独立工具调用对同一问题的核验；还需出现依赖闭环、诊断后调整方法、跨资源协调或调查核验中的至少一种。各维度可累加：

| 证据维度 | 分值 |
|---|---:|
| 检查 → 有关联的改动 → 后续独立验证 | 5 |
| 非机械失败 → 根因诊断 → 调整方法 → 独立验证 | 6 |
| 明确关联的跨资源协调 | 4 |
| 只读调查结论 → 后续独立核验 | 5 |
| 工具输出中的因果、依赖或比较判断 | 3 |
| 成功的验证证据 | 2 |
| 检查、改动、验证中包含至少两类操作 | 1 |

默认总分至少 `11`。分数用于调节送审成本；即使调低阈值，重复次数和普通重试也不能绕过上述实质证据要求。它不是对任务难度的测量，也不是成功概率。

初筛属于可解释的保守规则，目的是减少无效复盘，不能证明真实语义复杂性。模型必须分别提供复杂性与沉淀价值的结构化说明及可核对证据；发布前检查这些说明、引用、验证和已有技能关系。规则分数和模型评估都可能误判，不能据此宣称生成技能必然正确或有用。

完成事件仅触发检查。模型仍需判断任务是否完成，并引用任务内可核对的验证证据。插件检查格式、引用和候选质量，不会重新执行生成内容中的验证步骤。实际提炼质量与复用效果需要持续观察。

后台任务使用 SQLite 持久队列，短事务领取任务，在数据库事务外调用模型。可重试失败会按退避时间重试；重启后恢复中断任务。多个会话依次处理，并发进程通过数据库协调。写入采用版本检查与原子替换，发布中断后可核对状态。

**OpenCode 退出后没有独立守护进程继续提炼。** 已入队任务保留，下次启动同一项目时恢复。立即退出的 `opencode run` 可能来不及采集完成证据；需要稳定自动提炼时，使用交互式 OpenCode 或持续运行的 `opencode serve`。

## 查看状态和诊断

```powershell
node bin/autoskill.mjs status --runtime --project D:\your-project
node bin/autoskill.mjs doctor --project D:\your-project
node bin/autoskill.mjs doctor --opencode D:\tools\opencode.exe --project D:\your-project
node bin/autoskill.mjs recover --dry-run --project D:\your-project
node bin/autoskill.mjs recover --project D:\your-project
```

`status` 查看配置安装状态；`--runtime` 增加队列计数、任务摘要、最近决定、原因代码、计数指标及已观测的宿主能力。任务摘要中的 `preScreen` 显示初筛策略版本、分数、维度与拒绝原因，便于核对为何送审或跳过。未运行过的项目显示 `not-started`。输出不包含队列中的会话证据正文。

`doctor` 检查配置、未知或非法选项、丢失的本地插件引用、模块子进程导入和 CLI 版本，并提示全局作用域是否也启用了插件。`OPENCODE_BIN` 可指定 CLI。仅 **2.2.7** 被标为已测试；其他版本需要重新验证。模块成功导入与实际宿主激活分别展示，宿主能力以运行记录为准。

`recover` 恢复失效执行租约，不通过直接删除锁文件实现。正在执行且租约有效的任务保持运行。v0.1 的旧状态会迁移；明确已死亡的旧进程锁会留作诊断记录。损坏或无法判定的旧锁需要检查状态文件，避免误认另一个仍在运行的实例。

OpenCode 中也可调用：

- `autoskill_status`：查看运行状态。
- `autoskill_review`：复盘最近完成边界以前、尚未处理的任务；`dryRun=true` 预览候选而不发布 Skill。
- `autoskill_load`：在当前任务的候选中按需加载技能，并再次核对归属、版本和预算。
- `autoskill_search`：根据当前任务或补充的具体问题检索候选摘要，默认最多 5 个；继续遵守原任务的技能排除要求。
- `autoskill_feedback`：模型报告当前任务是否使用该技能及结果；与用户显式反馈分开保存。

这些是模型工具，不是斜杠命令。普通使用无需手动触发。

## 管理生成的 Skills

```powershell
node bin/autoskill.mjs skills list --project D:\your-project
node bin/autoskill.mjs skills inspect <skill-id> --project D:\your-project
node bin/autoskill.mjs skills pin <skill-id> --project D:\your-project
node bin/autoskill.mjs skills unpin <skill-id> --project D:\your-project
node bin/autoskill.mjs skills archive <skill-id> --project D:\your-project
node bin/autoskill.mjs skills restore <skill-id> --project D:\your-project
node bin/autoskill.mjs skills rollback <skill-id> --version <版本> --project D:\your-project
node bin/autoskill.mjs skills adopt <skill-id> --project D:\your-project
node bin/autoskill.mjs skills feedback <skill-id> --outcome success --notes "实际复用成功" --project D:\your-project
node bin/autoskill.mjs skills prune --keep 50 --older-than 30 --dry-run --project D:\your-project
```

`list` 返回摘要，`inspect` 展示正文、来源和可回滚版本。上述子命令也可直接使用，例如 `opencode-autoskill pin <skill-id>`。

- **人工修改保护**：通过内容 hash 检测修改。自动更新只作用于仍由插件管理、未固定的 Skill。手写和已人工修改的正文不会自动覆盖。
- **固定**：`pin` 阻止自动更新与清理，`unpin` 解除固定。
- **归档/恢复**：`archive` 从活跃技能目录移出；`restore` 可恢复归档。`rollback` 恢复 `inspect` 列出的历史版本，不会默默覆盖人工修改。
- **重新接管**：`adopt` 明确将当前正文交回插件管理；先检查正文，后续自动更新将以它为基线。
- **反馈/清理**：记录成功或失败反馈；`prune` 仅归档未固定、仍受管理的旧技能。先保留最近使用的 `--keep` 个，再应用 `--older-than`。默认保留 50 个。

修改命令支持 `--dry-run` 预览。技能容量由 `maxManagedSkills` 限制，不会自动删除手写技能。

## 候选模式

配置 `"mode": "draft"` 后，仍自动筛选和提炼，候选保存在私有运行目录，发布时不再调用模型：

```powershell
node bin/autoskill.mjs drafts list --project D:\your-project
node bin/autoskill.mjs drafts inspect <draft-id> --project D:\your-project
node bin/autoskill.mjs drafts publish <draft-id> --dry-run --project D:\your-project
node bin/autoskill.mjs drafts publish <draft-id> --project D:\your-project
node bin/autoskill.mjs drafts discard <draft-id> --project D:\your-project
```

发布时重新检查引用、质量与当前技能版本。正文已变更或目标已被固定时拒绝覆盖，候选保留供检查。默认 `mode: "auto"`，无需逐次发布。

### 升级到 v0.3

既有已发布 Skill 保留，不会因初筛策略版本变化而重复提炼。旧版因复杂度不足被跳过的任务，在下一次检查时可按新策略重新评估；尚未执行的队列任务也使用新规则。

旧候选如果缺少 v0.3 要求的结构化复杂性与价值评估，不能直接发布。恢复记录显示 `legacy_draft_requires_review`；先用 `drafts inspect` 查看，需清理时用 `drafts discard`。要生成合规候选，需要在 OpenCode 中完成新的任务并通过当前复盘；没有把旧草稿直接补审或强制发布的命令。

## 文件和隐私

```text
你的项目/
└─ .opencode/
   ├─ skills/<skill-id>/SKILL.md      # 可提交给团队的技能正文
   └─ autoskill/                    # 自动忽略的私有运行目录
      ├─ runtime.sqlite             # 队列权威状态
      ├─ reuse.sqlite               # 复用任务/技能版本阶段、模型报告、用户反馈
      ├─ state.json                 # 不含会话正文的诊断投影
      ├─ events.jsonl               # 事件和决定记录
      ├─ provenance/<id>/SOURCE.json # 来源、指纹和证据引用
      ├─ drafts/                    # 未发布候选
      └─ backups/                   # 技能历史版本

用户私有状态目录/
├─ config-backups/<配置路径hash>/   # 每份配置最近10个备份
├─ installations/                  # 安装身份记录，用于路径迁移
└─ …                               # 跨项目调用预算
```

项目运行目录和用户私有状态目录自动添加忽略规则。生成的 `SKILL.md` 不携带完整来源证据；旧版技能旁的来源记录会安全迁移到私有目录。技能正文是否提交由团队决定。

复用账本只保存任务/技能 ID、查询哈希、技能内容哈希、阶段和反馈统计，不保存用户任务原文或完整技能正文。近期详细阶段记录会压缩，保留去重与按版本累计所需的信息。

用户私有状态目录默认是 `$XDG_STATE_HOME/opencode-autoskill`，未设置时为 `~/.local/state/opencode-autoskill`。`AUTOSKILL_STATE_HOME` 可覆盖它。配置备份可能包含凭证，因此保存在该目录，按配置路径隔离，每份配置最多保留 10 份。不要将状态目录配置为项目根目录或项目的父目录。

提炼请求会将会话摘要和工具证据发送给选定的模型 provider，并消耗额度。可设置 provider 允许名单、文件/工具/会话排除及自定义敏感文字片段；输入和候选正文均做常见密钥脱敏。`storeEvidence: "none"` 可不保留来源中的证据摘录。脱敏不是对任意私人内容的识别保证。

可清理已终结任务的旧证据，默认保留 30 天，先预览再执行：

```powershell
node bin/autoskill.mjs clean --older-than 30 --dry-run --project D:\your-project
node bin/autoskill.mjs clean --older-than 30 --project D:\your-project
```

`clean` 清除符合时间条件的已终结任务快照、来源/备份中的证据摘录，以及已发布或丢弃候选的证据。保留待执行任务、未发布候选、技能正文、内容 hash、归属和去重记录。不要通过删除整个运行目录清理证据，否则会丢失人工修改保护所需的来源信息与去重记录。

## 配置

编辑 `plugins` 中本插件的 `options`，完整例子见 [examples/opencode.jsonc](examples/opencode.jsonc)。未知字段和非法值会明确报错，避免拼错后静默失效。

| 选项 | 默认值 | 作用 |
|---|---|---|
| `enabled` / `mode` | `true` / `"auto"` | 自动运行开关；`"draft"` 仅生成候选 |
| `reuseEnabled` | `true` | 新任务的自动检索、匹配与上下文加载开关 |
| `reuseCandidateLimit` / `reuseAutoLoadLimit` | `5` / `2` | 本轮候选摘要数/自动加载完整技能数上限 |
| `reuseMinScore` / `reuseAutoLoadScore` | `0.16` / `0.62` | 候选/自动加载的本地相关性阈值；仍需通过约束、冲突和安全检查 |
| `reuseStaleAfterDays` | `180` | 超过该时间的旧版本停止自动推荐；不删除技能正文 |
| `reuseMaxContextChars` / `reuseMaxSkillChars` | `16000` / `6000` | 单任务复用上下文/单个完整技能的字符预算 |
| `reuseTimeoutMs` | `5000` | 单次复用准备超时；失败时主任务继续 |
| `minToolCalls` / `minToolCallsWithErrors` | `8` / `4` | 已弃用的兼容参数；保留旧配置解析，不再使任务入选 |
| `minComplexityScore` | `11` | 所有自动初筛候选均需达到的证据评分；仍必须满足实质信号与验证要求 |
| `debounceMs` / `cooldownMs` | `2000` / `60000` | 事件稳定等待/同会话复盘间隔 |
| `maxReviewsPerDay` / `maxGlobalReviewsPerDay` | `20` / `100` | 项目/用户级每日模型调用次数上限 |
| `maxEstimatedTokensPerDay` / `maxGlobalEstimatedTokensPerDay` | `250000` / `1000000` | 项目/用户级每日估算输入 token 上限 |
| `maxEstimatedInputTokens` / `maxPromptChars` | `40000` / `80000` | 单次完整提示的估算 token/字符预算 |
| `maxTranscriptChars` / `maxToolOutputChars` | `60000` / `6000` | 会话/单条工具输出字符预算 |
| `reviewTimeoutMs` | `90000` | 单次提炼超时 |
| `maxAttempts` / `retryBaseMs` / `retryMaxMs` | `2` / `5000` / `300000` | 失败尝试上限和重试退避 |
| `minConfidence` / `maxSkillChars` | `0.85` / `16000` | 最低置信度/生成技能字符上限 |
| `relevantSkillLimit` / `maxManagedSkills` | `8` / `100` | 提示内相关技能数/自动管理容量 |
| `language` | `"zh-CN"` | 生成内容语言 |
| `model` | 沿用任务模型 | 可选 `{ "providerID": "...", "id": "..." }` |
| `providerAllowlist` | `[]` | 非空时，仅允许列出的 provider |
| `excludeTools` / `excludeSessions` | `[]` / `[]` | 排除指定工具和会话 |
| `excludeFiles` | 常见敏感路径 | 文件路径 glob；自定义数组替换配置列表，内置敏感文件规则始终生效 |
| `sensitivePatterns` | `[]` | 至少 3 字符的敏感文字片段，按字面匹配，非正则 |
| `storeEvidence` | `"redacted"` | 来源保留脱敏摘录，或设 `"none"` |
| `globalStateDirectory` | 用户私有状态目录 | 可选：跨项目预算存储目录 |

每日预算按 UTC 日期重置。预算按实际送入提示的内容估算，并在调用前预留；失败尝试也消耗预留预算。当前宿主生成接口返回文本，未提供可靠的实际 usage、输出 token 上限或强制 JSON schema 能力。因此这些限制是调用次数和估算输入预算，不是精确金额或总 token 的硬上限。`doctor` 显示实际观测到的能力。

更新已有 Skill 时，模型需要看到完整旧正文；旧正文放不进本次预算时跳过更新，避免丢失原有步骤。去重结合相关技能检索、模型判断和 ID/标题/描述检查。

## 安装迁移、启停和卸载

```powershell
node bin/autoskill.mjs install --project D:\your-project --dry-run
node bin/autoskill.mjs disable --project D:\your-project
node bin/autoskill.mjs enable --project D:\your-project
node bin/autoskill.mjs uninstall --project D:\your-project
node bin/autoskill.mjs install --global
```

只有显式 `--global` 才修改用户 OpenCode 配置，不能与 `--project` 或 `--config` 混用。全局启用后仍在任务所属项目生成 Skills。项目和全局重复启用时，先用 `doctor` 检查配置。

升级或搬迁后，在新包目录重新运行 `install`，会识别包名、旧目录的包身份或已有安装记录，合并重复项并保留首项 options。若旧版目录已删除且没有安装记录，可显式指定原配置中的引用：

```powershell
node bin/autoskill.mjs install --project D:\your-project --replace D:/old/opencode-autoskill
```

`disable` 和 `uninstall` 在重新加载 OpenCode 后生效。卸载移除插件配置，保留技能、候选、历史版本与运行记录；不会把整份旧配置恢复回来。

配置安装、迁移、同步和清理等管理命令的 `--dry-run` 只预览，不调用模型或提交对应变更。**便携 CLI `review --dry-run` 与 OpenCode/MCP 工具 `autoskill_review` 的 `dryRun` 会调用模型、消耗预算并保存候选，只是不发布 Skill 正文。** 候选可通过 `drafts inspect/publish/discard` 管理。

## 开发和验证

```powershell
npm test
npm run check
npm run evaluate
npm run smoke
npm run smoke:reuse
npm pack
npm run package-check -- .\opencode-autoskill-0.4.0.tgz
```

`npm test` 覆盖配置、候选校验、任务切分、队列恢复、技能保护与 CLI 生命周期。`smoke` 启动隔离的真实 OpenCode 服务和仅监听本机的模拟模型，验证插件加载、直接工具与 Code Mode 证据、后台提炼、保存与刷新。它还在模型响应挂起时终止 CLI，再启动同一项目，核对持久队列恢复、第二次尝试和发布提交状态。它使用临时项目和独立 HOME；`OPENCODE_BIN` 可指定 CLI 路径。

`npm run smoke` 不隐式重新编译，源码修改后先运行 `npm run build`。模拟模型和客户端使用 Node 内置能力，打包安装后也能直接运行 `node scripts/smoke.mjs`，无需安装开发依赖。

`npm run smoke:reuse` 通过真实 OpenCode 与本机模拟模型验证后续任务复用：高相关正文自动进入主模型上下文；未知前提先核实，再通过 `autoskill_load` 加载、应用并核验；模型使用报告与用户反馈区分；同一会话中的无关新任务不继承旧上下文。还检查原生受管技能清单收缩、外部用户技能保留。脚本为 `scripts/reuse-smoke.mjs`，不会调用额外 reviewer 模型；模拟模型通过只能说明集成链路可运行。

`package-check` 对指定 tgz 做全新生产依赖安装、模块加载、CLI 安装/启停/卸载、离线评测及提炼/复用两类真实宿主 smoke，所有项目与配置均隔离在临时目录。

`evaluate` 默认运行候选校验样例、独立标注的复杂度初筛回放及技能检索路由回放，不调用模型。三类指标分别报告；`reuse` 包含候选召回、错误/漏掉的自动加载、每项条件和排除原因。这些检索指标不代表实际复用成功率。还可回放真实 reviewer 输出或显式连接 reviewer endpoint；这两种方式只替换提炼决策，复用检索仍为本地回放。输入格式与指标范围见 [评测说明](evaluation/README.md)。

真实 CLI 与模拟模型验证集成链路，真实模型的提炼质量仍需用实际任务评测。适配层使用 SDK 2.2.7 的类型开发，运行时无需加载 SDK；宿主升级前需要重新验证。依赖审计结果以当前 `npm audit` 为准。

自动加载由匹配、已知前提、版本及预算决定；实际采用和执行仍依赖模型对当前任务的判断。插件不会保证每个复杂任务都生成文件，也不会把“已加载”计为“实际复用成功”。

每个模型请求按用户消息 ID 与原始首段文本 hash 关联任务修订；OpenCode 追加的附件文本不参与该 hash。其他插件若改写原始首段文本导致无法精确关联，本次附加复用跳过，主任务继续。加载账本表示插件返回过正文，不保证提供商接收请求或模型实际采用。

实现为原创代码。接口依据：[OpenCode 服务端插件 API](https://opencode.ai/docs/build/plugins/server/)、[插件加载](https://opencode.ai/docs/build/plugins/)、[Skills](https://opencode.ai/docs/skills/)。
