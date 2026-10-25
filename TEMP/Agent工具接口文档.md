# Agent 工具接口文档

本文只列 Agent 可调用的工具与操作类目，用于排查 Agent 设计问题；不列网络接口。

## 总览

Studio 有三类 Agent，不是三类都能调用同一批工具：

| 类型 | 当前调用方式 | 是否有工具调用能力 |
| --- | --- | --- |
| 内置流水线 Agent（planner / storyboard / material / edit / audio / qc） | 后端按计划阶段组装上下文，模型返回 JSON | planner 返回计划；执行 Agent 没有通用工具循环，只返回本阶段结果 |
| 内置对话 Agent（scope=storyboard 用 storyboard，scope=edit 用 conversation） | ReAct 工具循环，工具直接写分镜/时间线；返回运行记录 | 有，受 scope 限制；旧 `operations` / `filmOps` 仍兼容 |
| 外部 ACP / MCP Agent | 外部 Agent 调用项目 MCP 工具 | 有，受下面的 MCP 工具表限制 |

`agent-cards` 里的 `tools` 字段目前是配置/展示信息，内置 `callAgent()` 并不会把它变成模型可调用的工具。例如 material 默认写着 `web-search`，实际流水线没有执行 web 搜索。排查时不要把配置字段当成已接通的工具。

> 本文末尾的“目标工具目录”是 ReAct / Plan-Execute 的补齐清单；其中 Plan-Execute、planner、匹配/补镜/交接工具和对话 ReAct 主链路已实现，其余读取/字幕/抽帧/工件工具仍按清单补齐。

### 能力矩阵

| Agent | 读上下文 | 素材检索 | 写分镜 | 写时间线 | 撤销 | 质检 | 预览 | 媒体生成 | 渲染/导出 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| planner | 是（注入摘要） | 否 | 计划 JSON | 否 | 否 | 否 | 否 | 否 | 否 |
| storyboard | 是（注入） | 否 | 返回完整文档 | 否 | 否 | 否 | 否 | 否 | 否 |
| material | 是（注入） | 后端语义索引 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| edit（流水线） | 是（注入） | 否 | 返回受限操作 | 否 | 否 | 否 | 否 | 否 | 否 |
| audio（对话） | 是（工具） | 是（音频） | 否 | 是（工具） | 是 | 否 | 是 | TTS/音乐/音效 | 否 |
| qc | 是（候选图/文档） | 否 | 否 | 否 | 否 | 自身审核 | 否 | 否 | 否 |
| conversation | 是（注入/工具） | 是（工具） | 工具直接写（兼容 operations） | 工具直接写（兼容 filmOps） | 工具快照 | 是（qc） | 是 | 否 | 否 |
| MCP（交接前） | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 否 | 否 |
| MCP（交接后） | 是（无 storyboard） | 是 | 否 | 是 | 是 | 是 | 是 | 否 | 否 |
| 命令行外部 Agent | 项目文件 | 否 | 否 | 否 | 否 | 否 | 否 | `openfilm get` | `openfilm render` |

表中的“返回”表示 Agent 不直接持有写工具，只返回 JSON，由 Studio 校验并应用。命令行外部 Agent 不是内置 Agent，也不是 MCP。

## 按 Agent 类型

### storyboard（分镜规划）

- 输入：脚本/一句话、brief、已有 storyboard、锁定镜头。
- 输出：完整 storyboard JSON（title、brief、scenes、shots）。
- 可写：只通过返回的完整文档；后端校验后保存。
- 工具类目：流水线分镜步骤无通用工具；分镜页对话由该 Agent 以 ReAct 模式使用受控工具（读取、匹配、补镜、编辑分镜、校验、交接）。
- 不能：在流水线步骤中直接改时间线、渲染/导出。
- 关联确定性能力：`localStoryboard`、时长缩放、分镜结构校验。

### material（素材规划）

- 输入：当前镜头、叙事/画面要求、brief。
- 输出：查询词、候选说明、覆盖/缺口 JSON。
- 可写：无。
- 工具类目：无直接工具；实际检索由后端语义索引执行。
- `web-search` 只是卡片配置，当前不执行。
- 不能：把候选直接挂到时间线；不能生成媒体。

### edit（剪辑装配，流水线）

- 输入：storyboard 的镜头顺序、标题、narration、时长、已选素材。
- 输出：可安全检查的分镜结构操作：
  - `setTargetDuration`
  - `reorderShots`
  - `updateShot`，只允许 `title` / `targetMs`
- 可写：只通过上述操作，由流水线校验后写 storyboard。
- 不能：直接写 `film.html`、改素材路径、改音量/转场、渲染或导出。
- 注意：这里和对话 Agent 的 `filmOps` 不是同一权限范围。流水线 edit 只做结构连续性；时间线编辑由对话 Agent 的剪辑阶段（`scope=edit`）或 MCP 完成。

### audio（音频字幕）

- 独立工作槽，需配置模型；音效页 `scope=audio` 使用该 Agent 的 ReAct 工具循环。
- 工具：读取混音/时间线/字幕、搜索声音、列 TTS voices、生成 TTS/音乐/音效、导入网络音频、分析响度/波形、编辑字幕、原生 `edit_timeline` 落轨、撤销。
- 不建立第二套音频时间线；不渲染/导出；MCP 不开放音频生成。
- 未配置 Agent/provider 时返回可读错误，不写入修改。

### qc（自动质检）

- 输入：候选缩略图/帧、storyboard、影片事实（视觉模型可用时）。
- 输出：候选结论/置信度/理由（`verdict`/`confidence`/`reason`）、问题、修复建议、风险 JSON。
- 可写：无；只报告。
- 工具类目：视觉读取/审核能力，没有写工具。
- 独立确定性质检（MCP 的 `qc`）不依赖这个 Agent；它直接检查文档并返回问题。
- 不能：自己改分镜或时间线、渲染、导出。

### 对话 Agent（scope=storyboard / edit）

分镜阶段（`scope=storyboard`）使用 **storyboard Agent 的 ReAct 模式**：

- 输入：当前分镜摘要、选中镜头、候选和必要描述。
- 可用工具：读取项目/分镜/时间线、素材检索、QC、分镜校验、分镜编辑、匹配、补镜、交接、`ask_user`。
- 输出：`reply`、`runId`、`status`、`toolCalls`、`changed`、`applied`、`issues`；`ask_user` 时返回 `question`/`questionOptions`。
- 写路径：工具直接保存分镜；页面收到 `applied:true` 后重新读取，不再重复 apply。旧 `operations`/`proposal` 仍作为兼容路径。
- 不能：渲染、导出、音频生成。

剪辑阶段（`scope=edit`）使用 **conversation Agent 的 ReAct 模式**：

- 输入：当前时间线、选中 clip、项目文件列表；不再读取分镜。
- 可用工具：读取时间线/项目/文件、素材检索、QC、时间线编辑、撤销时间线、`ask_user`。
- 输出：同上；时间线写入由服务端工具直接应用并保留撤销快照。
- 不能：读取/修改 storyboard、生成 TTS/音乐、渲染/导出。

## 分镜 operations（conversation / MCP `edit_storyboard`）

所有操作按真实 id 定位；`type` 和常见的 `op` 别名都接受。空 `operations` 只能回答，不能声称已经修改。

| 类目 | 操作 | 主要参数 |
| --- | --- | --- |
| 时长 | `setTargetDuration` | `durationMs` |
| 时长 | `distributeDurations` | `durationMs` |
| 时长 | `setShotDuration` | `shotId`, `targetMs` |
| 镜头 | `updateShot` | `shotId`, `patch` 或直接字段；`state` 支持 `draft/matched/review/gap`，`confirmed` 归一化为 `matched` |
| 镜头 | `deleteShot` / `duplicateShot` | `shotId` |
| 镜头 | `reorderShots` | `shotIds`（全部镜头，一次且不重复） |
| 镜头 | `moveShot` | `shotId`, `index`/`to` |
| 镜头 | `addShot` | `shot` 或字段, `sceneId`, `index` |
| 场景 | `addScene` / `updateScene` | `title`, `sceneId` |
| 匹配 | `setMatch` | `shotId`, `candidateId`（兼容 `selectedId`/`id`） |
| 匹配 | `clearMatch` / `rematchShots` | `shotId` / `shotIds` |
| 锁定 | `lockShots` | `shotIds` 或 `shotId` |
| Brief | `setBrief` | `durationMs`, `aspect`, `tone`, `notes` |

锁定镜头不能被改；无效 id、越界时长会返回错误，不会部分写入。视觉复核结果只影响 `match.review` 和 `state`，匹配度仍是语义分数。

## 时间线 filmOps（conversation edit / MCP `edit_timeline`）

使用 clip id 和秒；`clip` 兼容 `clipId` / `clip_id`。

| 类目 | 操作 | 主要字段 |
| --- | --- | --- |
| 字段 | `set` | `clip`, `field`, `value` |
| 位置 | `move` | `clip`, `at`, `track?` |
| 新增/复制 | `insert` | `clip` 或 `from`, `at?`, `track?`, `after?` |
| 删除 | `remove` | `clip` |
| 分割 | `split` | `clip`, `at` + `time`/`restTime`，或 `left`/`right` |
| 批量属性 | `props` | `edits:[{clip, prop, value}]`，如 `volume`、`fade`、`speed`、`track` |
| 原始字段 | `fields` | `clip`, `fields` |
| 轨道 | `track` | `track`, `field: muted/locked/hidden`, `value` |
| 轨道顺序 | `reorder` | `from`, `to` |
| 画布 | `stage` | `w`, `h` |

时间线写入保存 `.film/agent-undo.json` 快照；MCP 的 `undo_timeline` 可恢复最后一次工具编辑。锁定轨道/片段、媒体路径不存在的插入会被拒绝。

## MCP / ACP 外部 Agent 工具

当前工具共 18 个，按工作阶段裁剪：

| 类目 | 工具 | 参数/返回 |
| --- | --- | --- |
| 读 | `read_project` | 无参数；交接前含分镜摘要，交接后 `phase: edit` 且不含分镜 |
| 读 | `read_storyboard` | 无参数；交接后隐藏 |
| 读 | `read_timeline` | 无参数；返回时间线摘要和已校验的影片值 |
| 读 | `list_project_files` | 无参数；返回媒体、页面、文件夹 |
| 搜索 | `search_materials` | `query`, `topK?`；返回命中素材，不自动挂载 |
| 质检 | `qc` | 无参数；确定性检查，只返回问题 |
| 预览 | `preview` | 无参数；只提示 Studio 更新预览，不渲染 MP4 |
| 写分镜 | `edit_storyboard` | `baseRevision?`, `operations`；和分镜 operations 同一套实现；交接后隐藏 |
| 匹配 | `match_storyboard` | `shotIds?`, `topK?`；语义检索并保存候选；交接后隐藏 |
| 补镜 | `fill_storyboard` | `shotId`, `prompt?`, `duration?`；明确生成一个缺口镜头；交接后隐藏 |
| 校验 | `validate_storyboard` | 无参数；确定性分镜/时间线检查；交接后隐藏 |
| 交接 | `handoff_storyboard` | 无参数；把已匹配分镜写入原生时间线并标记交接；交接后隐藏 |
| 写时间线 | `edit_timeline` | `base?`, `ops`；和原生时间线编辑同一套实现 |
| 撤销 | `undo_timeline` | 无参数；恢复上次 `edit_timeline` 前的时间线 |
| 工作区 | `workspace_list` | `path?`；列出项目 Agent 工作区 |
| 工作区 | `workspace_read` | `path`；读取工作区文本文件 |
| 工作区 | `workspace_write` | `path`, `content`；写入工作区文本文件 |
| 代码 | `run_code` | `language:"node"|"python"`, `code`, `timeoutMs?`；在工作区运行小脚本，非 shell |

阶段规则：

- `handedOffAt` 之前：18 个工具都可见。
- `handedOffAt` 之后：隐藏 `read_storyboard`、`edit_storyboard`、`match_storyboard`、`fill_storyboard`、`validate_storyboard`、`handoff_storyboard`，剩余 12 个；工作区/代码工具仍可用。
- 没有渲染、导出、TTS、配乐工具；`fill_storyboard` 是显式补镜生成，不是渲染/导出。
- 工具错误通过工具结果返回，不是传输失败。

## 项目级 Agent 工作区

每个项目有独立工作区，位于项目的 `.film/agent-workspace/`：

- 内置 Agent 按角色隔离：`planner`、`storyboard`、`material`、`edit`、`audio`、`qc`、`conversation`。
- 外部 MCP Agent 使用 `.film/agent-workspace/shared/`。
- 代码运行目录是该角色的工作区；环境变量提供 `OPENFILM_PROJECT`、`OPENFILM_WORKSPACE`、`OPENFILM_AGENT_ROLE`。
- 支持 Node.js 和 Python，不支持 shell 命令字符串；默认超时 10 秒（最大 30 秒），输出上限 64KB。
- 工作区工具只允许相对路径，拒绝 `..`、绝对路径和符号链接；不会把 provider key 放进脚本环境。
- 工作区随项目移动/删除；不是安全沙箱，不能把它当作绕过文档工具或渲染/导出的入口。

## 命令行工具（外部 Agent 可用，内置 Agent 不调用）

一个在项目目录里工作的命令行外部 Agent 还可以用：

| 类目 | 命令/能力 |
| --- | --- |
| 打开/查看 | `openfilm open`、`openfilm look` |
| 渲染 | `openfilm render`（用户最终交付仍由 Studio 导出中心负责） |
| 媒体获取 | `openfilm get`：`voice`（列声音）、`tts`、`music`、`sfx`、`asr`、`image-search`、`image`、`video`、`web-search`、`web-fetch`、`call` |
| 能力发现 | `openfilm skills`、`openfilm skill <name>`、`openfilm doctor` |

这些是命令行行为，不是 MCP 工具；内置对话/流水线 Agent 没有任意命令执行权。语音合成、配乐、音效页面的生成属于 Studio 后端能力，不自动成为 Agent 工具。

## 目标工具目录（ReAct / Plan-Execute，部分已实现）

> 这一节是在 `TEMP/修改方案.md` 基础上继续补齐的工具清单。当前真实状态是上面的 18 个 MCP 工具；分镜页对话执行 storyboard Agent 的工具循环，剪辑页执行 conversation Agent 的工具循环，音效页执行 audio Agent 的工具循环，旧 `operations` / `filmOps` 仍兼容。`match_storyboard`、`fill_storyboard`、`handoff_storyboard`、`validate_storyboard` 已经接通 MCP；内置流水线已使用 Plan-Execute。新增 `planner` 工作槽，其余六个角色保留。
>
> 状态标记：
>
> - `已有/MCP`：实现已在 MCP 工具层，内置 Agent 尚未接入。
> - `已有/HTTP`：Studio 已有确定性实现或路由，还没有 Agent 工具封装。
> - `部分已有/HTTP`：只有部分逻辑或仅支持一种模式，完整工具仍需补齐。
> - `缺失`：需要新增 Agent 工具或完整实现；不等于后端完全没有相关能力（例如字幕、媒体探测已有路由，只是没有工具封装）。
> - `预留`：音频或生成能力已有部分后端，但当前不向 Agent 开放，或依赖后续 schema。
>
> 工具名是 Agent 工具名，不是 HTTP 路径；同一个工具在对话、MCP 和流水线中必须复用同一套实现。渲染、导出、最终发布不属于 Agent 工具，不在这里补。

### 1. 共享读取、检索、分析与交互工具

| 工具 | 用途 | 当前状态 |
| --- | --- | --- |
| `read_project` | 项目摘要；交接前含分镜摘要，交接后只含剪辑阶段 | 已有/MCP |
| `read_storyboard` | 完整分镜、镜头、候选、选中素材 | 已有/MCP |
| `read_timeline` | 轨道、片段、裁剪、位置、已校验影片值 | 已有/MCP |
| `list_project_files` | 媒体、页面、文件夹，用于插入已有素材 | 已有/MCP |
| `read_script` | 读取项目脚本/创作说明/用户选定的源文本；不是分镜本身 | 缺失 |
| `read_captions` | 读取字幕行、时间、样式和字幕轨状态 | 缺失 |
| `read_transcript` | 读取带时间戳的转写文本，用于检索、对齐和剪辑 | 缺失 |
| `find_transcript` | 按台词/关键词定位时间点，返回片段/轨道/帧范围；用于旁白、B-roll 和字幕对齐 | 缺失 |
| `search_materials` | 项目素材索引的语义检索，返回候选，不自动挂载 | 已有/MCP |
| `search_stock_media` | 检索外部图片/视频素材；只返回候选和来源，不自动采用 | 缺失（可选，需版权/供应商配置） |
| `probe_media` | 探测时长、分辨率、帧率、编码、音频流、媒体是否存在 | 缺失 |
| `view_asset_frames` | 抽取素材关键帧/缩略图，供分镜、素材、QC 做视觉判断 | 缺失 |
| `view_timeline_frames` | 按时间线时间抽帧，供剪辑和 QC 看实际成片 | 缺失 |
| `analyze_audio` | 分析响度、峰值、削波、静音和波形 | 缺失（音频分析后端已有部分能力） |
| `review_candidates` | 对单个镜头的候选做视觉复核；只写复核结论，不改选中/置信度 | 缺失 |
| `qc` | 确定性检查分镜、素材覆盖和时间线，只返回问题 | 已有/MCP |
| `validate_storyboard` | 在提交前做结构、锁定、时长、候选和交接前不变量检查 | 缺失 |
| `preview` | 提示 Studio 更新预览；不渲染 MP4 | 已有/MCP |
| `undo_storyboard` | 恢复上一次分镜工具写入前的快照 | 缺失 |
| `undo_timeline` | 恢复上一次时间线工具写入前的快照 | 已有/MCP |
| `read_capabilities` | 读取当前可用 Agent、工具、供应商、阶段和权限 | 缺失 |
| `read_artifact` | 读取大工具结果/帧/分析报告的引用，支持分页和字段选择 | 缺失 |
| `read_plan` | 读取计划、步骤状态、依赖、失败原因和运行结果 | 缺失 |
| `ask_user` | 在缺少关键信息时暂停循环，向用户提出一个明确问题 | 缺失 |
| `start_plan` | conversation 把复杂目标交给 planner 创建粗剪计划 | 缺失 |
| `cancel_plan` | 停止计划执行；不提交未完成的草稿 | 缺失 |

### 2. 共享写入、生成与运行工具

| 工具 | 用途 | 当前状态 |
| --- | --- | --- |
| `generate_storyboard` | 从脚本/需求初始生成分镜；锁定镜头不能被静默覆盖 | 缺失 |
| `edit_storyboard` | 分镜 operations；和 Studio 分镜应用同一套校验 | 已有/MCP |
| `edit_timeline` | 原生时间线 `applyOps`；音频片段也必须走这里 | 已有/MCP |
| `edit_captions` | 新增/替换/调整字幕行与样式，复用字幕文档，不另建时间线 | 缺失 |
| `match_storyboard` | 按镜头检索并选择候选；语义分数为准，视觉复核只写 `match.review` | 已实现/MCP |
| `fill_storyboard` | 补齐一个缺口镜头；显式生成视频，不负责批量搜索 | 已实现/MCP（生成模式） |
| `handoff_storyboard` | 把已匹配分镜交接为时间线粗剪，写入 `handedOffAt` | 已实现/MCP |
| `generate_shot` | 显式生成一个镜头素材（图像/视频）；可选，默认不开放，需供应商和费用策略 | 缺失/预留 |
| `import_media` | 导入本地或已授权网络素材到项目；不自动采用为分镜选中 | 部分已有/HTTP（本地上传有，Agent/网络封装缺失） |
| `transcribe_audio` | 对音频/视频运行 ASR，产出台词转写；音频 Agent 预留 | 缺失/预留 |
| `write_plan` / `replan` | planner/编排器内部生成和重写计划；不作为普通模型工具 | 已实现/内部 |
| `render` / `export` | **禁止** | 不提供 |

### 3. planner（计划编排，已新增）

目标：只做计划和拆解，不直接写工程；未绑定模型时，编排器使用默认五阶段计划。

- 读取：`read_project`（已有/MCP）、`read_storyboard`（已有/MCP）、`read_timeline`（已有/MCP）、`read_script`（缺失）、`read_captions`（缺失）、`find_transcript`（缺失）、`read_capabilities`（缺失）、`read_artifact`（缺失）。
- 计划：`read_plan`（缺失）；`write_plan` / `replan`（缺失，由编排器内部调用，不给模型任意写）。
- 验收输入：`qc`（已有/MCP）、`validate_storyboard`（已实现/MCP）。
- 交互：`ask_user`（缺失），只用于关键信息缺失；不能把计划决策推给用户。
- 可选读取：`search_materials`（已有/MCP），用于判断计划是否具备素材条件。
- 禁止：`edit_storyboard`、`edit_timeline`、`match_storyboard`、`fill_storyboard`、`handoff_storyboard`、`edit_captions`、音频生成、渲染/导出。
- 计划输出必须包含步骤角色、依赖、输入、验收条件；不能包含无法验证的自然语言步骤。

### 4. storyboard（分镜规划）

目标：把脚本/需求变成可执行分镜，并在交接前补齐结构。

- 必须读取：`read_project`（已有/MCP）、`read_storyboard`（已有/MCP）、`read_script`（缺失）、`search_materials`（已有/MCP，用于参考素材/视觉方向）。
- 生成/编辑：`generate_storyboard`（缺失；初始生成，不能静默覆盖锁定镜头）、`edit_storyboard`（已有/MCP）、`fill_storyboard`（已实现/MCP）、`generate_shot`（缺失/预留，仅显式授权时）、`undo_storyboard`（缺失）。
- 校验/预览：`validate_storyboard`（已实现/MCP）、`qc`（已有/MCP）、`preview`（已有/MCP）。
- 视觉读取：`view_asset_frames`（缺失），用于参考图和生成后的镜头确认。
- 禁止：`edit_timeline`、`handoff_storyboard`、`edit_captions`、音频生成、渲染/导出。
- 边界：分镜 Agent 不直接决定时间线；交接由 edit Agent 的计划步骤完成。

### 5. material（素材规划）

目标：理解镜头需求，检索、筛选和补齐候选；不直接改时间线。

- 必须读取：`read_storyboard`（已有/MCP）、`read_script`（缺失）、`read_captions`（缺失）、`search_materials`（已有/MCP）、`find_transcript`（缺失）。
- 检索/分析：`search_stock_media`（缺失，可选）、`probe_media`（缺失）、`view_asset_frames`（缺失）。
- 写入：`match_storyboard`（已实现/MCP）；只改镜头候选/选中，不写时间线。
- 覆盖判断：`qc`（已有/MCP）用于读取缺口；发现缺口时把 `gap` 结果交给计划层/storyboard，不直接生成。
- 禁止：`edit_storyboard` 的通用结构操作、`fill_storyboard`、`edit_timeline`、`handoff_storyboard`、`edit_captions`、生成类工具、渲染/导出。
- 边界：素材 Agent 只提出“缺口/建议生成”，生成和费用由计划层显式决定；不能把搜索命中直接写入时间线。

### 6. edit（剪辑装配）

目标：把分镜交接成时间线，并完成结构、转场、字幕和音轨的基础装配。

- 必须读取：`read_project`（已有/MCP）、`read_timeline`（已有/MCP）、`list_project_files`（已有/MCP）、`read_script`（缺失）、`read_captions`（缺失）、`find_transcript`（缺失）。
- 交接/写入：`handoff_storyboard`（已实现/MCP）、`edit_timeline`（已有/MCP）、`edit_captions`（缺失）、`undo_timeline`（已有/MCP）。
- 检索/分析：`search_materials`（已有/MCP）、`probe_media`（缺失）、`view_timeline_frames`（缺失）、`read_artifact`（缺失）。
- 校验/预览：`qc`（已有/MCP）、`preview`（已有/MCP）。
- 禁止：交接后 `read_storyboard` / `edit_storyboard`；`fill_storyboard`（生成缺口由计划层决定）；渲染/导出。
- 边界：时间线的所有原生能力都通过 `edit_timeline` 完成，不新增第二个时间线模型。

### 7. audio（音频字幕，独立工作槽）

目标：声音库、网络声音、TTS、配乐、音效、字幕、分析和混音；所有落轨仍走原生时间线。

- 读取：`read_timeline`（已有/MCP）、`read_audio`（已实现/audio scope）、`read_captions`（已实现/audio scope）、`list_audio`（已实现/audio scope）。
- 声音库/检索：`search_audio`（已实现/audio scope，含本地/Freesound/Jamendo）。
- 生成/导入：`list_voices`（已实现/audio scope）、`generate_audio`（已实现/audio scope，TTS/音乐/音效）、`import_audio`（已实现/audio scope）。
- 分析：`probe_audio`（已实现/audio scope）、`analyze_audio`（已实现/audio scope，响度/波形）、`normalize_audio`（缺失）、`duck_audio`（缺失，需原生音量自动化支持）。
- 字幕：`edit_captions`（已实现/audio scope，line/style/translate/transcribe）。
- 落轨：`edit_timeline`（已有/MCP）；插入、移动、裁剪、音量、淡入淡出全部复用 `applyOps`，不新增音频时间线模型。
- 预览/撤销：`preview`（已有/MCP）、`undo_timeline`（已有/MCP）。
- 禁止：渲染/导出；需在设置中绑定模型；MCP 不开放音频生成。

### 8. qc（自动质检）

目标：独立检查事实、视觉、音频、字幕和交接完整性；只报告，不写入。

- 读取：`read_project`（已有/MCP）、`read_storyboard`（已有/MCP）、`read_timeline`（已有/MCP）、`read_script`（缺失）、`read_captions`（缺失）、`find_transcript`（缺失）、`read_artifact`（缺失）。
- 分析：`probe_media`（缺失）、`view_asset_frames`（缺失）、`view_timeline_frames`（缺失）、`analyze_audio`（缺失）、`review_candidates`（缺失，视觉候选复核）、`validate_storyboard`（已实现/MCP）。
- 检查：`qc`（已有/MCP）；`preview`（已有/MCP）只用于看结果。
- 禁止：`edit_storyboard`、`edit_timeline`、`edit_captions`、匹配/交接、生成、渲染/导出。
- 输出：问题、证据、修复建议、风险；修复由 planner/edit 执行后再次调用 `qc` 验收。

### 9. conversation（ReAct 对话）

目标：一个连续工具循环的剪辑 Agent；复杂目标可交给 planner，简单目标直接工具编辑。

- 读取：`read_project`（已有/MCP）、`read_storyboard`（已有/MCP）、`read_timeline`（已有/MCP）、`list_project_files`（已有/MCP）、`read_script`（缺失）、`read_captions`（缺失）、`find_transcript`（缺失）、`read_artifact`（缺失）。
- 检索/分析：`search_materials`（已有/MCP）、`search_stock_media`（缺失，可选）、`probe_media`（缺失）、`view_asset_frames`（缺失）、`view_timeline_frames`（缺失）。
- 分镜写入：`edit_storyboard`（已有/MCP）、`match_storyboard`（已实现/MCP）、`fill_storyboard`（已实现/MCP）、`handoff_storyboard`（已实现/MCP）、`undo_storyboard`（缺失）、`validate_storyboard`（已实现/MCP）。
- 时间线写入：`edit_timeline`（已有/MCP）、`undo_timeline`（已有/MCP）。
- 媒体导入：`import_media`（缺失）；检索到的外部素材必须经此导入后才能插入。
- 字幕：`read_captions`（缺失）、`edit_captions`（缺失）。
- 验收/预览：`qc`（已有/MCP）、`preview`（已有/MCP）。
- 计划：`start_plan`、`read_plan`、`cancel_plan`（均缺失）。
- 交互：`ask_user`（缺失），仅用于缺失关键信息；不是审批门。
- 禁止：渲染/导出；交接后读/改分镜；默认不开放 TTS/音乐/图像/视频生成（`fill_storyboard` 的生成模式需显式授权）。
- 写入边界：ReAct 工具写入运行草稿，成功后自动提交；返回 `applied`、`changed`、`rev`，页面不能再重复 apply。

### 10. MCP / ACP 目标工具集

在当前 18 个工具上继续补齐以下工具；外部 Agent 和内置 Agent 共用实现：

| 工具 | 用途 | 状态 |
| --- | --- | --- |
| `read_script` | 读脚本/创作说明 | 缺失 |
| `read_captions` | 读字幕/时间/样式 | 缺失 |
| `read_transcript` | 读带时间戳转写 | 缺失 |
| `find_transcript` | 按台词定位时间点 | 缺失 |
| `read_artifact` | 分页读取大工具结果 | 缺失 |
| `probe_media` | 媒体技术信息 | 缺失 |
| `view_asset_frames` | 素材抽帧 | 缺失 |
| `view_timeline_frames` | 时间线抽帧 | 缺失 |
| `search_stock_media` | 外部素材检索（可选） | 缺失 |
| `import_media` | 导入本地/已授权网络素材（可选） | 部分已有/HTTP（本地上传有，Agent/网络封装缺失） |
| `edit_captions` | 字幕写入 | 缺失 |
| `generate_storyboard` | 从脚本/需求初始生成分镜 | 缺失 |
| `match_storyboard` | 分镜匹配/重匹配 | 已实现/MCP |
| `fill_storyboard` | 补镜/缺口处理（显式生成） | 已实现/MCP |
| `handoff_storyboard` | 分镜交接为时间线 | 已实现/MCP |
| `undo_storyboard` | 分镜工具撤销 | 缺失 |
| `validate_storyboard` | 交接前结构校验 | 已实现/MCP |
| `review_candidates` | 候选视觉复核 | 缺失 |

阶段规则（目标）：

- `handedOffAt` 之前：可用读取、检索、匹配、补镜、校验、分镜编辑和交接工具。
- `handedOffAt` 之后：隐藏 `read_storyboard`、`edit_storyboard`、`generate_storyboard`、`match_storyboard`、`fill_storyboard`、`handoff_storyboard`、`undo_storyboard`、`validate_storyboard`、`review_candidates`；保留时间线、字幕、素材探测、抽帧、QC、预览、撤销时间线工具。
- `handoff_storyboard` 成功后立即改变阶段；之后的编辑不能再读取或修改分镜。
- `search_stock_media` / `import_media` 是可选工具，必须限制来源、授权目录和版权；不允许通过工具读取项目外的任意文件。
- 不加入音频生成、TTS、配乐、渲染或导出。音频 Agent 启用后再单独评审 MCP 暴露范围。

### 11. 实现复用与边界

| 目标工具 | 应复用的现有能力 |
| --- | --- |
| `generate_storyboard` | 现有流水线分镜生成/规范化；生成后仍走 `normalizeStoryboard` 和锁定校验 |
| `match_storyboard` | `matchStoryboard()` + `saveStoryboard()`；跨镜头去重和语义分数保持现有行为 |
| `fill_storyboard` | 现有 `storyboard/fill` 生成逻辑；先由 `match_storyboard` 检索，生成是单独的显式动作 |
| `handoff_storyboard` | `handoffClips()` + `saveStoryboard()`；写入 `handedOffAt` 和 `roughcut` |
| `undo_storyboard` | 新增分镜快照；不能复用时间线 `agent-undo.json` |
| `edit_captions` | 字幕/字幕段现有后端；不新建时间线 |
| `edit_timeline` | 现有 `applyOps` / `editProjectFilm`；音频落轨也只能走这里 |
| `probe_media` / `view_*` | 现有媒体探测、缩略图和帧抽取能力 |
| `analyze_audio` / 音频生成 | 现有 `audio.mjs` 和音频供应商；Agent 工具只做适配，不复制音频后端 |

## 排查清单

- 看模型实际返回：`.film/agent-chat.json`、模型调用日志、`.film/logs/`（App 的 ACP 会话）。
- 看操作是否真的产生变化：`.film/storyboard.json`、`film.html`、`.film/agent-undo.json`。
- 回复说“已修改”但文档没变，先检查返回 JSON 是否有 `operations` / `filmOps`，以及是否使用真实 id。
- 分镜对话只返回提案，页面应用后才写 storyboard；剪辑对话的 `filmOps` 在对话请求内直接应用。
- `agent-cards` 的 `tools` 字段不等于已接通工具；当前真正的工具入口只有 MCP（外部）和内置 JSON 操作。
- 音效页现在有独立的 `scope=audio` 与音频 Agent 工具（读取混音、搜索/生成音频、原生时间线写入）；MCP 仍不开放音频生成。
