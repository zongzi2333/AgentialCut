# OpenChatCut：Agent 对话剪辑、记忆管理与 MCP 设计分析

> 分析对象：`D:\Tools\OpenChatCut`（package version 0.2.17）
> 关注点：只讨论通用机制与架构逻辑，不展开源码细节。
> 结论先行：这不是一个“Plan-and-Execute”系统，而是一个以 **ReAct 工具循环**为主、叠加 **技能化流程（Skills）**与 **事后验收循环（Acceptance）** 的编辑 Agent；其最核心的架构取舍是 **“模型循环在服务端，工程修改权在浏览器”**。

---

## 0. 一页结论

| 维度 | 结论 |
|---|---|
| 对话剪辑 | 服务端持有模型循环；工具调用通过事件流下发给浏览器；浏览器在“草稿工程”上执行 EditorCore 命令；结束后生成提案，用户确认后原子落地 |
| 编辑安全 | 默认“提案制”：所有时间线修改先进入 draft，生成 Proposal，用户审批后一次性应用；应用前自动存版本，可作为一步撤销 |
| Agent 范式 | ReAct 为主：模型自主决定下一步工具，循环直到不再调用工具；没有独立 Planner/Executor，也没有持久化的执行计划对象 |
| “计划”在哪里 | 只在提示层和技能层：`planMode` 是一句系统提示；SKILL.md 是“流程知识”；`acceptance` 是编辑后的验证回合 |
| 记忆主链路 | 对话历史持久化 → 上下文预算与压缩 → 检查点摘要 → 大结果工件化 → 运行账本与恢复 |
| 上下文策略 | 缓存友好的“稳定前缀 + 易变尾部”；分层压缩；按缓存命中率动态调整触发阈值；溢出时静默重试 |
| MCP | Streamable HTTP；Bearer Token；5 个控制工具 + 6 个编辑会话工具 + 全套编辑工具；默认全量暴露，可选渐进式暴露；支持浏览器绑定与离线服务端直连 |
| MCP 安全模型 | 草稿隔离、会话状态机、参数摘要绑定的一次性确认、项目修订号防陈旧、浏览器注册凭证、运行账本幂等 |
| 最大特点 | 内置 Agent 与外部 MCP Agent 共用同一套工具目录与 EditorCore 命令，没有第二套工程格式或第二套编辑 API |

---

## 1. 全局架构与职责边界

### 1.1 三层职责

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| 服务端（Vite/Node 或 Electron 内嵌服务） | 模型循环、上下文构建与压缩、重试、运行事件流、MCP 服务、离线草稿执行、密钥与代理 | 不直接改在线工程的 ProjectDoc（内置 Agent 的在线路径） |
| 浏览器/编辑器（React） | 真实工程状态、草稿引擎、EditorCore 命令、撤销栈、提案审批、工程与聊天持久化 | 不持有模型 API Key，不直接调用模型供应商 |
| 共享层 | 工具 Schema、参数校验、执行策略、工具激活、技能目录、提案与操作模型 | — |

这不是“前后端各写一套”。项目刻意维持 **单一工具目录 + 单一命令层**：内置 Agent、Codex/Copilot 后端、外部 MCP 客户端最终都落到同一批工具与同一套 EditorCore 命令上。

### 1.2 一条用户消息的完整生命周期

1. 用户在聊天框输入指令，可附带素材、时间线片段、时间点、字幕选区等引用。
2. 浏览器把“当前模型历史 + 本轮消息 + 工具目录 + 系统提示 + 模型配置”提交给服务端，创建一个 Agent Run。
3. 服务端不是立刻执行，而是先做准入与延迟启动，避免并发运行和重复提交。
4. 服务端构建上下文，调用模型；模型可以输出文本、思考内容或工具调用。
5. 若模型要调用工具，服务端把 `tool-request` 事件写入运行事件流（SSE），并等待浏览器领取。
6. 浏览器领取该工具请求，在“草稿工程上下文”中执行对应工具；工具内部通过 EditorCore 命令修改草稿。
7. 浏览器把执行结果、产生的 store actions、参数摘要回传给服务端；服务端把它作为工具结果继续下一轮模型调用。
8. 服务端循环执行第 4–7 步，直到模型不再调用工具，或触发取消/失败。
9. 服务端发出终态事件；浏览器根据本轮所有工具产生的 actions 生成 Proposal。
10. 手动模式下，用户在聊天面板查看提案、预览、勾选操作、批准或拒绝；自动模式下，编辑在工具执行时就已实时落地。
11. 批准时，浏览器先保存“修改前版本”，再把选中的操作原子回放到当前 ProjectDoc，并作为一步可撤销修改提交。
12. 会话、模型历史、运行账本、上下文用量、提案状态分别持久化，供刷新、重启、换页后恢复。

### 1.3 为什么这样切

- **模型循环放服务端**：浏览器刷新、切页、短暂断网不会中断模型推理；运行事件可回放；长任务更稳。
- **修改权放浏览器**：工程状态、撤销栈、预览、媒体 Blob 都在客户端；让服务端直接写工程会绕过校验、撤销和实时预览。
- **草稿隔离**：模型可以在一个“影子工程”上连续试错，用户看到的真实时间线在批准前不变。
- **提案制**：把“模型说了什么”与“工程实际改了什么”分开，避免模型口头成功但工程没变。

> 例外：外部 MCP 的“离线模式”会在服务端用同一套 EditorCore 在草稿副本上执行，再原子提交。这是为了在浏览器没打开工程时仍能工作，不是内置 Agent 的主路径。

---

## 2. 对话剪辑是如何实现的

### 2.1 运行编排：服务端是“大脑”，浏览器是“手”

服务端负责四件事：

- 组装系统提示与消息历史；
- 管理上下文预算、压缩、重试；
- 驱动模型回合，并把工具请求送入事件流；
- 维护运行状态、事件窗口、工具请求的领取与结算。

浏览器负责四件事：

- 领取并执行工具；
- 在 draft 上调用 EditorCore；
- 收集 actions 与时间线差分；
- 生成提案、保存版本、原子应用、撤销与恢复。

这种拆分的关键不是“前后端分离”，而是 **认知与执行权分离**：模型可以建议任何操作，但只有浏览器能真正改变工程。

### 2.2 模型回合与工具桥

- 服务端每个回合调用一次模型，工具以标准 JSON Schema 暴露。
- 工具执行不是服务端本地函数调用，而是“请求—领取—执行—回传”的异步桥：
  - 服务端登记工具请求（含 toolCallId、参数摘要）；
  - 通过 SSE 发出 `tool-request`；
  - 浏览器 claim 该请求，执行后 POST 结果；
  - 服务端解除等待，把结果并入下一轮消息。
- 工具有“排他”和“并行”两种执行模式：
  - 默认排他，串行执行，避免并发修改 ProjectDoc、媒体池、审批状态；
  - 纯读工具（读工程、读时间线、搜索、分析、读字幕等）可并行；
  - 个别工具按参数判定是否只读（例如节拍检测只有在写标记时才排他）。
- 服务端对工具结果有重复保护：相邻的同一纯分析工具、同参数重复调用，会复用上次成功结果，避免重复解码/分析。
- 工具请求带 `toolCallId + argsDigest`，浏览器有持久化的“尝试记录”，用于刷新/重连后的幂等结算，避免同一工具被执行两次。

### 2.3 工具目录与执行管线

工具规模大约 110 个，覆盖：

| 类别 | 代表工具 |
|---|---|
| 工程/时间线读取 | read_project、read_timeline、read_script、read_captions、read_transcript、find_transcript |
| 片段编辑 | edit_item、update_item_props、move_item、set_item_timing、split_item、remove_item、duplicate_item、clear_timeline |
| 轨道/序列 | edit_track、manage_timelines、manage_link_group、multicam_sync、change_cam |
| 字幕/文本 | edit_captions、apply_caption_avoidance、place_graphics_in_safe_zone、clean_script、edit_gap、delete_text、remove_silence |
| 视觉/特效 | manage_effects、apply_layout、auto_reframe、inspect_color、auto_grade、submit_shader、create_motion_graphic、add_motion_graphic |
| 音频/音乐 | list_audio、add_audio、normalize_loudness、isolate_voice、detect_beats、analyze_music、sync_cuts_to_music |
| 媒体/生成 | import_media、finalize_uploaded_asset、download_media、push_asset、submit_image、submit_video、submit_voice、submit_music、submit_sound |
| 导出/发布 | submit_export、submit_render_job、track_export、verify_export、publish_to_social |
| 项目/技能/网络 | list_projects、create_project、manage_versions、manage_skill、install_skill、run_skill_script、run_code、web_search、web_crawl |
| 运行时 | ToolSearch、load_skill、read_agent_artifact、ask_followup_questions、report_user_friction、undo_last_change、redo_last_change |

一次工具调用的通用管线：

1. **激活检查**：当前请求是否有权调用该工具（工具激活是 token 优化，不是安全边界；历史中“记得”的工具会被临时准入）。
2. **参数校验**：用 JSON Schema/Ajv 校验并归一化；剔除 `__` 开头的内部字段，防止提示注入绕过内部幂等/重试机制。
3. **执行策略分类**：读、可逆编辑、持久本地副作用、不可逆外部副作用；同时给出恢复策略（纯函数、幂等、可恢复、结果未知）。
4. **时间线快照**：执行前记录轻量快照，用于生成差分。
5. **执行**：工具在草稿上下文里调用 EditorCore 命令；生成/上传/导出等真实副作用工具走各自的受控路径。
6. **差分**：执行后只描述变化（新增/删除/移位/属性变化/转场变化），不回传整棵时间线。
7. **结果整形**：大结果转工件引用；普通结果压缩到模型可消费的大小；图片帧以多模态内容返回。
8. **记账**：记录工具请求、参数摘要、执行结果摘要、工件 ID、成功/失败类别，进入运行账本。
9. **失败处理**：失败工具不应用其 actions；草稿回滚到调用前快照；错误返回给模型；模型可以修正后重试，但不能在未解决失败时宣称成功。
10. **结算**：把结果回传服务端，解除该工具调用的等待。

### 2.4 编辑落地：Draft → Proposal → 原子应用

这是整个系统最值得借鉴的部分。

**草稿层**

- 每个 Agent 回合创建一个 draft 引擎，包装同一套 EditorCore 命令，但修改的是 ProjectDoc 的副本。
- 一次 Agent 回合内的多个工具调用共享同一个 draft，因此模型能看到自己前面修改后的状态。
- 失败的工具会回滚草稿，避免“改了一半再失败”的脏状态污染后续工具。

**操作层**

- 每个工具产生的 store actions 被包装成 Operation：工具名、原始参数、actions、人类可读的动作、目标、影响描述、理由。
- 连续的完全重复调用会被合并显示，但不改变回放顺序。
- 操作分两类：
  - **持久副作用**（例如素材入库、生成的资产保存）：立即落地，因为它们已经写盘，且后续模型要读回素材池；
  - **时间线修改**：进入 Proposal，等待审批。

**提案层**

- Proposal 包含：标题、摘要、总影响、一个或多个选项、每个选项的操作列表、提案生成时的 baseDoc、预览用 resultState。
- 默认只有一个“应用全部”选项；结构支持多方案，但当前主要走单方案。
- 提案是否过期，通过比较 baseDoc 与当前 ProjectDoc 判断；比较做了缓存，避免每次渲染都序列化整棵工程。
- 过期提案不能直接应用，只能重新提案或强制应用。

**应用层**

- 批准时，按用户勾选的操作顺序回放 actions，得到最终 ProjectDoc。
- 先保存“修改前”的命名版本，再保存工程。
- 如果保存过程中发生并发编辑、页面卸载或写失败，会恢复当前实时工程，避免覆盖用户的新修改。
- 应用成功后，把结果 doc 作为一次 `applyDoc` 提交，形成一步可撤销修改。
- 拒绝提案会把“用户拒绝”写回模型历史，提示不要自动重试。

**自动模式**

- 手动模式：批准后才落地。
- 自动模式（YOLO）：工具执行时就把该工具的时间线修改实时落地，并把草稿 rebase 到最新工程，让模型和用户看到同一个状态。
- Ask 模式：只暴露只读工具，不产生修改。

### 2.5 反馈闭环：差分、编辑器状态、验收

系统不是“模型改完就说完成”，而是有三层反馈：

1. **请求时快照**：系统提示尾部附带 `<editor_state>`，包含 fps、画布、总时长、轨道别名、前 60 个片段、素材池统计。模型不必先调用 read_timeline 就能做小修改。
2. **修改后差分**：每次修改返回 changed diff（片段、移位规则、属性前后值、转场、删除项、新轨道、注意事项）。模型据此更新工作状态，而不是反复重读整个工程。
3. **自主验收**：可选的 acceptance 循环。只要本轮发生过修改，结束时运行时会要求模型再检查一次最新工程；模型用读工具/检查工具验证后，运行时才允许结束。默认最多 3 轮，可配置到 10 轮。若始终没有验证，运行会报“未在限定轮次内验证最新编辑”。

此外，系统提示明确要求：

- 视觉类修改后用渲染帧工具检查代表性帧；
- 不要从文件名推断媒体内容；
- 工具失败时报告确切失败，不要假装成功；
- 多阶段任务在手动模式下每阶段暂停确认，自动模式才端到端执行。

### 2.6 多后端差异

| 后端 | 模型循环在哪里 | 工具如何执行 | 备注 |
|---|---|---|---|
| API（AI SDK） | 服务端 | 服务端下发工具请求，浏览器执行 | 主路径；上下文压缩、验收、工具激活都完整生效 |
| Codex | 服务端 + Codex app-server | 服务端下发，浏览器执行 | 与 API 路径基本一致，保留工具桥与结算 |
| Copilot | 服务端 | 服务端下发，浏览器执行 | 同上 |
| Claude Code | Claude Code CLI 自己的循环 | CLI 通过 MCP 直接调用 OpenChatCut | 没有浏览器的 claim/结算桥；工具激活与部分提案记账不生效，按外部 MCP 客户端同等级信任处理 |

Claude Code 后端是一个重要特例：它把 OpenChatCut 的 MCP 服务作为自己的工具服务器，工具调用在 CLI 内部完成；OpenChatCut 只接收展示事件，不拦截、不结算。这让 Claude Code 能以“外部 Agent”方式工作，但也意味着它绕过了内置 Agent 的工具激活、工具领取和部分提案/撤销批处理逻辑。

### 2.7 失败与恢复语义

- 工具失败：不落地该工具的 actions；草稿回滚；错误可见；模型可选择修正或报告阻塞。
- 运行失败：运行状态、错误、事件窗口持久化；浏览器可从上次事件游标重连。
- 浏览器刷新：服务端循环继续；浏览器根据持久化的运行草稿和已完成工具恢复；未完成的工具不会被盲目重放，而是返回“浏览器在工具开始后重载，未自动重放”的错误。
- 工具结果丢失：通过 claim + 持久化尝试记录 + 结果回传重试，尽量做到“至多一次副作用、至少一次结果送达”。
- 会话清空：会话代际（session generation）轮换，旧聊天与旧运行不会被错误恢复；回退回合则截断展示历史与模型历史，并刷新上下文估算。

---

## 3. ReAct 还是 Plan-Execute？

### 3.1 判定证据

**支持 ReAct 的证据**

- 服务端主循环是“模型输出 → 工具调用 → 工具结果 → 再让模型决定下一步”，没有预先固定的步骤表。
- 没有回合上限：注释明确说“没有 turn cap，模型自己决定任务何时完成”；唯一的自动停止条件是“没有更多工具调用”或输出被截断。
- 运行状态里没有 plan 对象、步骤状态、依赖图或计划校验器；运行账本记录的是事件、工具、提案、检查点，不是计划节点。
- 工具选择由模型在每一步决定；`ToolSearch`、`load_skill`、`ask_followup_questions` 都是运行时按需调用，而不是计划阶段一次性决定。
- 遇到缺失信息时可以暂停提问，拿到回答后继续；这是典型 ReAct 的“观察—行动”循环。

**看起来像 Plan 的部分**

- `planMode` 设置：开启后在系统提示里加一句“先输出编号计划，等用户确认后再调用工具”。
  - 但它只是提示词约束，不是运行时的计划状态机；模型理论上仍可直接调用工具，系统没有强制拦截。
- Skills：每个 SKILL.md 是一套结构化工作流（建立编辑契约、构建素材地图、发现事件、证据账本、筛选、剪辑、验证）。
  - 但技能是“加载到上下文中的流程知识”，不是由运行时逐步执行的计划对象；执行仍由模型自由决定。
- `review_scene_plan`、`music_edit_plan`、`music_image_plan`：会产出计划型数据。
  - 但它们是建议性工具，运行时不强制执行，也不以计划完成度决定是否结束。
- 自动验收：编辑后强制一次验证回合。
  - 这是“验证/反思”，不是“先计划再执行”。

### 3.2 实际形态

可以概括为：

**ReAct 工具循环 + 可选的“先计划”提示 + 技能化流程 + 事后验收**

- **ReAct**：主控制流。
- **Plan-first**：可选的交互风格，不是执行架构。
- **Skills**：把专家流程写成可加载的“程序性记忆”，让 ReAct 在每一步有更强的局部决策依据。
- **Verify**：在修改后增加一次结构化自检，接近轻量 Reflexion，但没有跨任务的反思记忆库。

### 3.3 为什么不是 Plan-and-Execute

Plan-and-Execute 通常需要：

- 显式的计划数据结构；
- 计划生成阶段与执行阶段分离；
- 步骤完成度跟踪；
- 计划失败后的重规划；
- 执行器按计划调度工具。

OpenChatCut 没有这些运行时结构。它选择让模型在每一轮根据最新工程状态决定下一步，这对视频剪辑这种“强状态、强反馈、经常需要中途调整”的任务更自然：

- 素材探测结果会改变剪辑策略；
- 转写质量会影响是否能按文本剪；
- 生成任务耗时且可能失败；
- 用户经常在中途改主意。

硬编码计划反而容易在第一次工具结果与预期不符时失效。

### 3.4 代价与收益

**收益**

- 对缺失信息、工具失败、素材差异的适应性强；
- 不需要维护复杂的计划状态机；
- 用户可以随时插入新要求，Agent 在下一轮自然吸收；
- 与“工具即命令”的架构天然契合。

**代价**

- 长任务容易“走一步看一步”，缺少全局节奏控制；
- 多阶段任务依赖系统提示的“阶段暂停”规则，而不是运行时强制；
- 计划质量取决于模型与技能文本，缺少可验证的计划契约；
- 自动验收只能验证“最后一轮是否检查过”，不能保证计划完整。

### 3.5 如果要演进成混合模式

比较自然的演进不是推翻 ReAct，而是增加“轻量计划层”：

- 在运行账本中增加可选的 plan 记录（步骤、依赖、验收条件）；
- 计划只作为“当前工作假设”，每轮工具结果后允许修订；
- 对多阶段任务，运行时按阶段门控，而不是只靠提示；
- 验收循环从“检查最新编辑”升级为“对照计划逐项验收”；
- 保留 ReAct 的局部自由度，但给长任务一个可恢复的骨架。

---

## 4. 记忆管理

OpenChatCut 的“记忆”不是单一向量库，而是 **多层、不同生命周期、不同可信度的记忆体系**。

### 4.1 记忆分层

| 层 | 内容 | 生命周期 | 作用 |
|---|---|---|---|
| L0 请求内工作记忆 | 系统提示、编辑器状态快照、工具 Schema、激活工具集、当前消息历史 | 单次模型请求 | 让模型此刻知道“我是谁、工程长什么样、能用什么工具” |
| L1 对话记忆 | 展示消息、模型消息历史、变更日志、上下文用量、工具失败记录 | 跨请求、跨刷新 | 连续对话与恢复 |
| L2 压缩记忆 | 检查点摘要、摘要来源工件、摘要/来源摘要值、规范检查点消息 | 跨压缩、跨刷新 | 在上下文超限时保留“可继续工作的事实” |
| L3 结果工件 | 大工具结果、检查点来源文本、服务端运行草稿 | 跨请求、受保留策略约束 | 让模型只带“引用”而不是整块结果 |
| L4 运行账本 | 运行记录、事件、审批、检查点索引、工件索引、租约 | 运行中 + 历史保留 | 恢复、审计、幂等、并发控制 |
| L5 外部会话记忆 | 编辑会话草稿、操作列表、baseRevision、提案、终态 | 跨 MCP 调用、跨刷新 | 外部 Agent 的“未提交工作区” |
| L6 项目记忆 | 工程文档、命名版本、聊天、素材库、字幕/转写 | 长期 | 真正的工程事实来源 |
| L7 程序性记忆 | SKILL.md、技能引用文件、自定义技能 | 长期 | 专家流程与领域知识，按需加载 |

注意：这里没有“跨项目语义记忆库”。`sqlite-vec` 用于媒体语义搜索，不是对话记忆；对话的跨项目检索是显式的全文搜索工具，不是自动召回。

### 4.2 请求内上下文如何组织

系统提示采用“稳定前缀 + 易变尾部”：

- 稳定部分：角色、安全与权限、执行规则、领域规则、验证规则、回复风格、能力清单、技能索引、设计风格、产品身份、模式覆盖。
- 易变部分：`<editor_state>` 时间线快照，固定放在最后。

这样做的原因是 **提示缓存按字节前缀匹配**。如果把每轮都变的工程快照放在中间，后面的工具 Schema 和整段历史都会失去缓存，成本会显著上升。把易变内容放尾部，模式切换也只影响最小后缀。

工具 Schema 也不是全量常驻：

- 启动工具：ToolSearch、load_skill、read_project、read_timeline、ask_followup_questions、report_user_friction、read_agent_artifact。
- 根据最新用户请求做关键词/上下文路由，最多命中 4 组，预激活相关工具。
- 模型历史中曾通过 ToolSearch/load_skill 激活的工具会被回放。
- 激活状态还会写入消息的 providerOptions，压缩后仍能重建；如果模型“记得”一个本次未激活的规范工具，执行边界会临时准入，因为激活只是 token 优化，不是安全边界。

技能也采用渐进披露：

- 系统提示只放一个有预算上限的技能索引（约 12k 字符），描述“何时适用”。
- 真正调用 load_skill 时才返回 SKILL.md 正文；支持按文件、分页读取，单次结果有预算上限。
- 这样技能数量增加不会线性膨胀系统提示。

### 4.3 对话持久化

- 每个工程保存一份聊天快照：展示消息、模型消息历史、变更日志、上下文用量、工具失败记录、模型格式/供应商、服务端回合 ID。
- 存储走项目 KV：服务端工程存储是权威，IndexedDB 作为离线/本地回退。
- 写入按工程串行化，避免并发覆盖；服务端运行回合写入时用 runId 去重，防止同一回合被写两次。
- 读取有“不可读”状态：如果存储里有聊天但解析失败，不会用空会话覆盖，而是停止加载并提示用户；这是防止“刷新后聊天被清空”的关键保护。
- 会话代际：清空聊天会轮换 generation，旧代际的聊天不会被当成当前聊天加载；回退回合则通过同时截断展示历史与模型历史实现。
- Claude Code 后端额外维护 CLI 会话 ID：按“工程 + 会话代际 + 模型”缓存，后续消息可 `--resume`，避免每轮冷启动和重发历史；但一旦本轮失败、超时或发生压缩，就丢弃该会话 ID，防止 CLI 内部历史与 OpenChatCut 历史分叉。

### 4.4 上下文压缩：分层、可解释、可验证

压缩不是“超限就总结”，而是一条分层流水线：

| 阶段 | 动作 | 成本 | 触发/限制 |
|---|---|---|---|
| 1. 压力判断 | 估算当前 token，与触发阈值比较 | 零模型成本 | 默认窗口的 70%；缓存友好时 80%；缓存大量未命中时 65% |
| 2. 机械修剪（shake） | 把较旧的大工具结果替换成一行占位说明，保留工具名和调用记录 | 零模型成本 | 只处理 6 条消息之前、单条超过约 2000 字符的结果 |
| 3. 尾部救援 | 如果单条最近消息本身超大：先截断超大文本/工具结果，再退化为丢弃图片 | 零模型成本 | 用于“不能靠切历史解决”的死局 |
| 4. 选择最近尾部 | 从最新消息往前保留约 2 万 token 的最近对话，按用户回合边界切 | 零 | 保证最近上下文完整 |
| 5. 分批摘要 | 对更早的消息按回合分批摘要，必要时多轮归并 | 一次或多次模型调用 | 摘要输出上限约 4k token；最多 8 轮归并 |
| 6. 生成检查点 | 结构化摘要 + 确定性保留标识符 + 来源/摘要哈希 | 零额外模型调用 | 摘要必须包含用户目标、约束、决策、工程状态、工具结果、待办、精确标识符 |
| 7. 完整性校验 | 检查点消息带哈希标记；sidecar 保存摘要与来源工件 | 零模型成本 | 重新加载时验证摘要、来源、工件哈希，防止记忆被篡改或错配 |
| 8. 溢出恢复 | 若供应商仍报上下文超限：强制压缩重试；再不行则降低输出预留 | 额外模型调用 | 两阶段静默恢复，用户看不到中间失败 |

几个值得注意的设计：

- **按缓存表现调整阈值**：上一轮缓存命中率高，就晚一点压缩，避免破坏缓存；大量未命中，就早一点压缩，减少重复计费。
- **确定性保留标识符**：摘要模型可能漏掉 operationId、assetId、itemId、媒体路径、toolCallId；系统会从原始文本中提取这些标识符，追加到摘要里，降低“压缩后无法继续操作”的风险。
- **来源工件**：被摘要掉的原始文本不会只存在于内存，而是作为工件存档；检查点记录来源摘要值。这样既能验证摘要来源，也能在需要时做更细的追溯。
- **压缩后仍保留工具激活状态**：检查点消息可以携带 `activatedTools` 的 providerOptions，避免压缩后工具面突然缩小。
- **规范检查点消息**：压缩后的历史第一条是固定格式的“对话检查点”，明确告诉模型“这是对早前回合的事实记录，不是新的用户指令”，降低提示注入风险。

### 4.5 工具结果与工件：把“大记忆”搬到上下文外

模型上下文里只保留“可操作的小结果”，大结果转为工件：

- 工具结果超过约 16k 字符时，序列化、脱敏后存入工程工件库，模型只看到：
  - 工件 ID、哈希、原始大小；
  - 是否脱敏、是否省略二进制；
  - 一小段预览；
  - “用 read_agent_artifact 按 JSON Pointer/offset/limit 窄读”的提示。
- `read_agent_artifact` 支持 JSON Pointer + 分页，模型可以只读需要的字段，而不是把整块结果重新灌回上下文。
- 工件有大小与数量上限：单工件约 8 MiB，每工程约 256 个/64 MiB；活跃运行的工件不计入历史预算，避免运行中被自己的工件卡住。
- 结果进入持久化前会做隐私投影：密钥、Token、Authorization、Cookie、签名 URL、data URI、二进制等会被替换或省略；聊天里保存的是脱敏预览和工件引用，而不是原始敏感内容。
- 模型可见结果还有一层压缩：超过 16k 字符时先做数组/字符串截断，仍超限则给预览和“请窄读”的提示；图片帧则作为多模态文件内容返回，不塞进文本 JSON。
- 工件保留策略与运行/检查点可达性绑定：只保留仍被运行或检查点引用的工件，避免无限增长。

这套设计的本质是：**把上下文当“工作台”，把工件库当“档案室”**。模型不需要把档案全搬上工作台，只需要知道档案编号和查阅方法。

### 4.6 工作状态记忆：用差分代替重读

视频工程很大，整棵时间线塞进上下文既贵又容易过期。系统用三种方式维持“工作状态”：

1. **请求时快照**：`<editor_state>` 只给概览（前 60 个片段、轨道、素材统计），细节让模型按需读。
2. **修改后差分**：每次修改返回 changed diff，包含：
   - 新增/变更片段的最终位置；
   - 连续同轨移位压缩成“从某帧开始、移动多少、影响多少个”的规则；
   - 属性前后值（裁剪、变换、音量、关键帧、滤镜、特效、播放速率等）；
   - 转场变化、删除项、新轨道、注意事项；
   - 超过 30 个变更时只列前 30 个，并提示重读。
3. **稳定 ID 优先**：轨道别名 C1/V1/A1 只是展示用，真正定位用稳定 track ID / item ID；避免别名变化导致误操作。

这让模型可以“增量维护”自己的工作记忆，而不是每轮重新理解整个工程。

### 4.7 运行记忆：账本、租约、恢复

运行账本不是日志，而是恢复与幂等的基础设施：

- 每次运行有 runId、状态、模型/后端、用户输入摘要、上下文用量、事件序列、工具请求/结果、审批、提案、检查点、工件引用。
- 运行有租约（默认约 2 分钟有效，30 秒心跳）；只有持有租约的实例能写。页面关闭/崩溃后，租约过期，下一次打开可恢复或判定中断。
- 运行事件有容量上限和裁剪策略；关键事件（工具请求、工具开始/结果、提案应用/拒绝/过期、终态）优先保留。
- Agent 运行记录有保留上限（约 30 个运行、每个约 192 个事件、100 个审批、8 个检查点）；活跃运行与待审批运行受保护。
- 服务端运行额外维护事件游标、订阅者上限、工具请求 claim 状态；浏览器重连时从游标续传，不会重复消费。
- 服务端运行草稿会记录“哪些工具已经落地”，恢复时不会把自动模式已应用的操作再应用一遍。

### 4.8 外部 Agent 的记忆

外部 MCP 编辑会话有自己的“未提交工作区”：

- 会话保存：sessionId、客户端名、审批模式、baseRevision、baseDoc、draft 文档、操作列表、提案、时间戳、终态。
- drafting 阶段会把草稿检查点持久化；浏览器刷新或 MCP 传输断开后，浏览器绑定会话可通过 `list_edit_sessions` / `recover_edit_session` 恢复。
- 恢复是否允许，取决于草稿检查点的 baseRevision 是否仍与实时工程一致；不一致就判定 stale，不允许把旧草稿套到新工程上。
- 外部运行也有账本：工具请求、参数摘要、审批、结果、终态；用于一次性确认绑定、幂等和恢复。
- 离线模式把“服务端直连草稿”也纳入同一套会话状态机，提交时原子写入存储工程；失败则不产生部分修改。

### 4.9 跨会话记忆的边界

- **没有自动的长期语义记忆**：系统不会把历史对话自动向量化并在新会话召回。
- **有显式检索**：`search_content` 可跨工程全文搜索聊天、字幕、转写（服务端 SQLite FTS5），但是模型主动调用才会用。
- **有工程事实记忆**：工程文档、命名版本、字幕/转写、素材库本身就是长期记忆。
- **有程序性记忆**：SKILL.md 把可复用流程固化下来，比“记住上次怎么剪”更可控、可审计。
- **会话隔离**：清空聊天会轮换 generation，旧记忆不会被错误拼接；回退回合会截断两份历史并刷新上下文估算。

### 4.10 记忆设计评价

**优点**

- 分层清晰：短期上下文、对话历史、压缩摘要、工件、运行账本、工程事实各司其职。
- 成本意识强：缓存友好前缀、工具渐进披露、机械修剪优先于模型摘要、工件化避免大结果反复计费。
- 可恢复性强：租约、事件游标、幂等 claim、草稿检查点、提案持久化。
- 可验证性强：检查点摘要/来源哈希、来源工件、加载时校验。
- 安全边界清楚：脱敏、隐私投影、结果大小限制、不可读聊天保护。

**代价与风险**

- 摘要仍是模型生成，语义损失不可避免；确定性标识符只能降低“操作 ID 丢失”的风险，不能保证叙事/约束完整。
- 工件化要求模型主动窄读；如果模型不读，可能基于预览做错误判断。
- 压缩触发依赖 token 估算；估算偏差会导致过早压缩（浪费）或过晚压缩（溢出重试）。
- 运行账本、工件、检查点都有保留上限；超长项目历史会被裁剪。
- 外部会话状态在内存中，服务重启会丢失活动会话；草稿可恢复，但需要显式恢复流程。
- Claude Code 后端绕过内置工具桥，记忆/激活/提案记账与主路径不完全一致，这是已知限制。

---

## 5. MCP 是如何设计的

### 5.1 定位

OpenChatCut 的 MCP 不是“另一个远程 API”，而是：

- 让 Codex、Claude Code、Cursor、Qoder 等外部客户端，以标准 MCP 工具方式操作真实工程；
- 让内置 Claude Code 后端复用同一 MCP 服务；
- 与内置 Agent 共用同一套工具目录、参数校验、EditorCore 命令和草稿/提案语义；
- 保持本地优先：默认本机、单用户、Bearer Token、可选对外暴露。

MCP 服务端本身不能主动“调用浏览器”。浏览器是客户端，无法接受入站连接，所以采用 **HTTP 长轮询 Broker**：

- MCP 工具调用进入服务端队列；
- 浏览器注册后长轮询领取调用；
- 浏览器执行完把结果回传；
- 服务端把结果作为 MCP 工具返回值。

### 5.2 传输、认证与会话

| 项目 | 设计 |
|---|---|
| 端点 | `http://localhost:5199/api/external-mcp/mcp` |
| 传输 | MCP Streamable HTTP（POST/GET/DELETE，支持会话） |
| 认证 | `Authorization: Bearer <token>` |
| Token | 默认持久化在 `~/.openchatcut/mcp-token`（0600），可用 `OPENCHATCUT_MCP_TOKEN` 覆盖 |
| 会话头 | `mcp-session-id` |
| 请求体上限 | 约 2 MiB |
| 会话上限 | 64 个；空闲约 1 小时回收 |
| 会话回收 | 关闭传输、取消该会话的未完成编辑器调用 |
| 绑定模式 | `browser`（优先）或 `offline`（无浏览器占用时） |
| 工具列表变更 | 浏览器注册/注销、工具暴露变化时发送 `tools/list_changed` |
| 单用户假设 | 明确不是多租户服务；对外暴露需自加网络层保护 |

### 5.3 工具暴露模式

| 模式 | 行为 |
|---|---|
| `full`（默认） | 列出当前可用的全部工具（控制工具 + 会话工具 + 编辑器工具） |
| `progressive`（可选） | 初始只暴露启动集：ToolSearch、load_skill、read_project、read_timeline、read_agent_artifact、begin_edit_session、get_edit_session、review_edit_session、discard_edit_session；控制工具始终可见；通过 ToolSearch/load_skill 激活后，发送 `tools/list_changed` 增量扩大可见集 |

渐进模式的意义：外部客户端的工具列表也有上下文成本；先给“发现工具”和“最小读取/会话入口”，再按需展开。

### 5.4 接口清单

#### A. 控制工具（5 个，任何绑定状态下都可用）

| 工具 | 作用 |
|---|---|
| `openchatcut_status` | 查看已连接编辑器、当前传输绑定、绑定模式、工具暴露统计、能力状态 |
| `list_projects` | 列出工程（可按是否包含已删除过滤），返回编辑器 URL |
| `create_project` | 创建一个空工程（一个活动时间线、一条视频轨） |
| `target_project` | 把当前 MCP 传输永久绑定到某个工程：优先浏览器，否则离线；绑定后不能在该会话内切工程 |
| `get_editor_url` | 返回当前或指定工程的编辑器 URL |

#### B. 编辑会话工具（6 个）

| 工具 | 作用 |
|---|---|
| `list_edit_sessions` | 列出该工程的编辑会话，包括孤儿草稿的恢复元数据 |
| `recover_edit_session` | 恢复或丢弃孤儿会话；只有检查点仍匹配实时修订号时才允许恢复 |
| `begin_edit_session` | 开始一个隔离草稿；参数含客户端名、审批模式（manual/auto）、是否复用现有会话 |
| `get_edit_session` | 读取会话状态：drafting / awaiting_review / applied / rejected / cancelled / stale / failed |
| `review_edit_session` | 结束草稿：manual 显示审批卡；auto 直接应用整个草稿；真实工程工具不走草稿提交，manual 模式下每次另有一次性确认 |
| `discard_edit_session` | 丢弃草稿或待审提案，不改变真实工程 |

#### C. 编辑器工具（与内置 Agent 共用目录，约 110+ 个）

所有编辑器工具都会被注入 `editSessionId`，并要求绑定工程；另有 `editorProjectId` 作为工程选择器。按权限分为：

**C1. 全局读取（2 个）**

- `load_skill`：按需加载 SKILL.md/引用文件。
- `ToolSearch`：搜索并激活工具目录中的工具。

**C2. 草稿只读（约 20 个）**

- 工程/时间线：`read_project`、`read_timeline`、`read_script`、`read_captions`、`read_transcript`、`find_transcript`
- 画面/素材：`view_timeline_frames`、`view_asset_frames`、`browse_library`、`list_templates`、`search_templates`、`list_audio`、`search_media`、`search_stock_media`、`search_fonts`
- 音频/音乐分析：`analyze_music`、`inspect_music`、`music_edit_plan`、`music_image_plan`
- 工件/本地媒体：`read_agent_artifact`、`browse_local_media`

**C3. 草稿可写（约 27 个）**

- 片段/轨道：`update_item_props`、`move_item`、`set_item_timing`、`duplicate_item`、`remove_item`、`split_item`、`clear_timeline`、`set_aspect_ratio`、`edit_track`、`manage_timelines`
- 合成/视觉：`add_motion_graphic`、`edit_item`、`manage_effects`、`apply_caption_avoidance`、`place_graphics_in_safe_zone`、`auto_reframe`、`manage_design_style`
- 文本/字幕：`edit_captions`、`apply_script`、`update_watermark`、`manage_markers`
- 音频/导入：`add_audio`、`import_timeline`、`import_asset`、`import_assets`、`import_folder`
- 其他：`export_jianying_draft`

这些工具只修改会话草稿，不触碰真实工程；`review_edit_session` 才把整个草稿变成提案并提交审批。

**C4. 真实工程工具（其余约 60+ 个）**

包括但不限于：

- 生成：`submit_image`、`submit_video`、`submit_voice`、`submit_music`、`submit_sound`、`submit_shader`、`submit_motion_graphic`、`create_motion_graphic`、`create_motion_graphic_from_code`、`rerun_generation`、`track_progress`
- 导出/发布：`submit_export`、`submit_render_job`、`track_export`、`read_export_history`、`verify_export`、`export_motion_graphic_prores`、`publish_to_social`、`track_social_publish`
- 媒体/分析：`transcribe_track`、`clean_script`、`edit_gap`、`delete_text`、`remove_silence`、`normalize_loudness`、`isolate_voice`、`probe_media`、`detect_scenes`、`find_highlights`、`auto_grade`、`detect_beats`、`multicam_sync`、`change_cam`、`manage_link_group`、`review_scene_plan`、`sync_cuts_to_music`、`sync_images_to_music`、`download_media`、`push_asset`、`import_url_asset`、`request_asset_download`、`import_media`、`finalize_uploaded_asset`、`edit_asset`、`manage_media_pool`
- 项目/技能/网络：`delete_project`、`duplicate_project`、`edit_project`、`restore_project`、`manage_versions`、`manage_template`、`manage_skill`、`install_skill`、`run_skill_script`、`run_code`、`web_browser`、`web_search`、`web_map`、`web_crawl`、`web_batch_scrape`、`search_content`、`ask_followup_questions`、`report_user_friction`、`undo_last_change`、`redo_last_change`、`apply_layout` 等

真实工具的特点是：

- 作用于真实工程或真实外部系统；
- 不在草稿提交里回滚；
- manual 模式下每次调用要求一次性确认，确认绑定到“会话 + 运行 + 工具 + 精确参数摘要 + operationId”；
- 参数一变，旧确认失效；
- 失败调用的恢复策略会区分“可重试/幂等/结果未知”，不可逆外部副作用不会自动重放。

> 注意：这里有一个文档与实现的差异。README 的措辞接近“编辑会话只暴露草稿安全工具，生成/导出不可用”，但代码实际会把真实工具也列出来，只是每次调用走一次性确认（auto 模式下该确认会被跳过）。更准确的理解是：**真实工具不参与草稿提交，而不是完全不可见**。

#### D. MCP Prompts（6 个）

| Prompt | 用途 |
|---|---|
| `create-short-video` | 把当前工程剪成竖屏短视频（钩子、推进、高潮、收尾） |
| `transcribe-and-caption` | 转写并生成字幕，跳过无音轨片段 |
| `add-background-music` | 选配背景音乐并做响度标准化 |
| `generate-script` | 按素材写解说词/口播稿并规划分镜 |
| `export-project` | 导出成片并报告导出历史 |
| `clean-up-draft` | 删除填充词、静音停顿，收紧空隙 |

这些 Prompt 是“意图模板”，最终仍要模型调用工具完成，不是硬编码工作流。

#### E. HTTP 接口

**MCP 主端点**

| 方法/路径 | 作用 |
|---|---|
| POST/GET/DELETE `/api/external-mcp/mcp` | MCP Streamable HTTP 会话；POST 初始化或发送请求，GET 接收流，DELETE 关闭会话 |

**编辑器桥（浏览器内部使用，不是给外部 Agent 的公开 API）**

| 方法/路径 | 作用 |
|---|---|
| POST `/api/external-agent/bootstrap` | 编辑器启动引导，返回 MCP Token 等启动信息 |
| POST `/api/external-agent/register` | 浏览器注册工程与工具目录，返回注册凭证/所有权 epoch |
| POST `/api/external-agent/unregister` | 注销注册 |
| GET `/api/external-agent/poll` | 长轮询领取一个编辑器工具调用（约 25 秒） |
| GET `/api/external-agent/cancellation` | 长轮询接收取消通知 |
| POST `/api/external-agent/result` | 回传工具执行结果与终态 |
| GET `/api/external-agent/tools` | 读取当前注册的工具目录 |
| POST `/api/external-agent/import-token` | 生成导入上传凭证 |
| POST `/api/external-agent/upload-receipt` | 上传回执 claim/commit/abort |
| POST `/api/external-agent/jianying-export` | 剪映草稿导出 |
| POST `/api/external-agent/connect-client` | 一键写入 Claude/Codex/Cursor/Qoder 等客户端配置 |

**内置 Agent 运行接口**

| 方法/路径 | 作用 |
|---|---|
| POST `/api/agent-runs` | 创建运行（含消息、工具、模型、上下文参数） |
| POST `/api/agent-runs/:id/start` | 启动已准入的运行 |
| GET `/api/agent-runs/:id/events` | SSE 事件流，支持游标续传 |
| POST `/api/agent-runs/:id/tool-claim` | 浏览器领取工具请求 |
| POST `/api/agent-runs/:id/tool-result` | 浏览器回传工具结果 |
| POST `/api/agent-runs/:id/cancel` | 取消运行 |
| POST `/api/agent-runs/:id/settle` | 结算运行/提案状态 |
| POST `/api/agent-runs/:id/draft` | 保存运行草稿工件 |
| POST `/api/agent-runs/:id/draft/clear` | 清理运行草稿 |
| GET `/api/agent-runs/:id` | 读取运行元数据、事件窗口、状态 |
| GET `/api/project-store/search` | 跨工程全文搜索（聊天/字幕/转写） |

#### F. 关键请求头与参数

| 名称 | 用途 |
|---|---|
| `Authorization: Bearer ...` | MCP 认证 |
| `mcp-session-id` | MCP 传输会话 |
| `x-openchatcut-tool-exposure: progressive` | 选择渐进式工具暴露（也可用查询参数） |
| `x-openchatcut-mcp-client` | 标识客户端；内置 Claude Code 后端用 `claude-code-builtin` |
| `x-openchatcut-approval-mode` | 内置 Claude Code 后端的每轮审批模式，覆盖模型传入值 |
| `x-openchatcut-editor-registration` | 浏览器桥注册凭证 |
| `X-OpenChatCut-Run-Capability` | 内置 Agent 运行的能力凭证（浏览器持有） |
| `X-OpenChatCut-Editor-Bootstrap` | 编辑器启动引导标记 |
| `editSessionId` | 所有编辑器工具必填，绑定到草稿会话 |
| `editorProjectId` | 工程选择器，必须与会话绑定工程一致 |

### 5.5 编辑会话状态机与审批

状态：

- `drafting`：草稿可写。
- `awaiting_review`：草稿已冻结，生成提案，等待人工审批。
- `applied`：已原子应用。
- `rejected`：用户拒绝。
- `cancelled`：会话被丢弃/传输关闭。
- `stale`：工程在草稿期间被外部修改，草稿不能安全套用。
- `failed`：执行或提交失败。

审批模式：

- `manual`（默认）：`review_edit_session` 后展示审批卡；用户在 OpenChatCut 中预览、勾选、批准/拒绝。
- `auto`：`review_edit_session` 后直接把整个草稿提案应用到真实工程；不经过人工审批卡。
- 真实工程工具：manual 模式下每次调用单独走一次性确认门；参数摘要绑定，防止“确认 A 却执行 B”。
- 离线模式：只允许 `auto`，提交时原子写入；没有人工审批 UI。

关键安全点：

- 草稿与真实工程隔离；拒绝/过期不会产生部分修改。
- 每个会话有 `baseRevision`；实时工程一变，会话立即判 stale。
- 一次应用事务是“全有或全无”：要么按所选操作生成的结果整体保存，要么什么都不写；manual 模式允许用户只勾选部分操作，但保存本身是原子的。
- 一次性确认绑定会话/运行/工具/参数摘要/operationId；不能跨调用复用。
- 外部 Agent 断线时，未完成的调用会被取消；草稿保留用于恢复，而不是静默丢失。

### 5.6 浏览器桥的内部协议

虽然外部客户端只看到 MCP，但真正的工作机制是桥：

1. 浏览器打开工程后，用当前工程修订号和完整工具目录注册。
2. 服务端做工程编辑所有权 claim，返回注册凭证和 epoch。
3. 浏览器长轮询 `/poll` 领取调用；调用带 callId、工具名、参数、绑定信息。
4. 浏览器在草稿/真实工程上执行，POST `/result` 回传 outcome + value + 新修订号。
5. 服务端把结果交给等待中的 MCP 调用；如果工具修改了工程，同步更新注册修订号。
6. 如果工程被外部改动、编辑器关闭、会话过期或调用超时，服务端取消挂起调用，并向 MCP 客户端返回 `stale`/`cancelled`/`failed`。
7. 取消通知通过 `/cancellation` 长轮询推给编辑器，避免编辑器继续执行已失效的调用。

这个桥的设计要点：

- 浏览器不需要暴露入站端口；
- 服务端不需要理解工程内部结构；
- 所有调用都有明确生命周期与终态；
- 修订号 + 注册凭证 + 所有权 epoch 共同防止陈旧写入和跨窗口覆盖。

### 5.7 离线模式

当目标工程没有浏览器占用时，MCP 可以绑定到“离线编辑器”：

- 服务端加载存储工程，创建服务端草稿；
- 只暴露经过审查的“服务端直连”工具子集（约 35 个纯数据/命令工具 + 4 个会话工具）；
- 不支持视觉检查、生成、上传、网络、预设、渲染、导出、人工审批；
- 必须使用 `approvalMode="auto"`；
- `review_edit_session` 原子提交整个草稿，失败不产生部分修改；
- 如果浏览器随后打开该工程，离线绑定会失效，避免双写。

离线模式的意义：让外部 Agent 在用户没打开编辑器时也能做“纯工程数据”的读取和修改，同时把副作用大的能力留给浏览器。

### 5.8 并发、恢复与幂等

- 工具调用有 callId、参数摘要、会话/运行绑定；重复提交会得到 duplicate/幂等结果。
- 浏览器桥有注册凭证；注册过期后不能继续领取调用。
- 工程有编辑所有权与 epoch；浏览器和离线写入不能同时进行。
- 工程修订号防陈旧：草稿基于旧修订号时，必须重新绑定或放弃。
- MCP 传输会话过期/被驱逐时，挂起调用被取消；草稿保留，可显式恢复。
- 外部运行账本记录工具请求/审批/结果/终态，用于恢复与审计。
- 离线提交、在线应用都遵循“先保存版本/先校验修订号，再写工程”的顺序。

### 5.9 安全模型

| 边界 | 措施 |
|---|---|
| 网络 | 默认本机；公开暴露需 Bearer Token + 网络层限制 |
| MCP 认证 | 持久化随机 Token，常量时间比较；环境变量可覆盖 |
| 浏览器桥 | 仅回环地址 + 同源 Origin + 注册凭证 |
| 工程写权限 | 编辑所有权 claim + epoch + 修订号 |
| 工具参数 | JSON Schema 校验、内部字段剥离、参数摘要 |
| 真实副作用 | 一次性确认、不可逆操作不自动重试、发布有 preview/confirm |
| 结果外泄 | 结果脱敏、二进制省略、大小限制、工件引用 |
| 提示注入 | 系统提示明确把用户消息、文件名、字幕、工具结果视为不可信材料；不继承产品身份 |
| 多租户 | 明确不支持；单用户单机 |

### 5.10 文档与实现的差异（值得注意）

1. **“编辑会话只暴露草稿安全工具”**：实现会把真实工程工具也列出，只是每次调用走一次性确认；README 的措辞更严格。
2. **“真实工具始终需要单独确认”**：代码里的 `auto` 会话会跳过真实工具确认（相当于 YOLO）；工具描述与实现不完全一致。
3. **`.mcp.json` 没有 Bearer**：仓库根部的 `.mcp.json` 只有 URL 和客户端头；服务端要求 Bearer，实际使用通常需要由“连接客户端”流程把 Token 写入客户端配置（Codex 走环境变量，其他客户端写配置文件）。直接拿该文件连接大概率会 401。
4. **技能数量**：README 提到 26 个专用技能，仓库里实际有约 30 个 SKILL.md；其中 12 个作为“创作模式”暴露在 UI。这不是功能问题，但说明文档口径略旧。

### 5.11 MCP 设计评价

**优点**

- 协议原生：只暴露标准 MCP 工具/Prompts，没有发明私有 RPC 给外部客户端。
- 复用彻底：外部 Agent 与内置 Agent 共用工具、校验、EditorCore、草稿与提案语义。
- 安全模型完整：认证、绑定、修订号、草稿隔离、一次性确认、幂等、审计。
- 恢复能力强：会话恢复、孤儿草稿、离线回退、事件游标、工具 claim。
- 渐进披露：既支持“全量兼容”也支持“按需激活”，兼顾客户端能力与上下文成本。
- 可观测：状态工具返回绑定、编辑器、工具数、暴露模式、最后激活信息。

**代价**

- 浏览器桥是自定义长轮询协议，复杂度不低；出错路径多（stale/cancelled/failed/timeout/duplicate）。
- 外部会话状态在内存中，服务重启会丢失活动会话（草稿可恢复）。
- 工具数量大，外部客户端即使全量暴露也会面临工具选择成本；渐进模式需要客户端配合。
- 真实工具与草稿工具的边界需要用户理解；auto 模式绕过确认会放大误操作风险。
- 单用户单机假设明确，不适合直接做多租户 SaaS。
- 文档与实现存在若干口径差异，接入方容易误判。

---

## 6. 可复用的设计模式

如果要在另一个“Agent + 专业桌面应用”里复刻这套架构，最值得拿走的是这些模式：

1. **认知与执行权分离**  
   模型循环可以放服务端，但真正修改领域状态的操作必须走客户端命令层。

2. **Draft → Proposal → Atomic Apply**  
   先影子执行，再让用户审批，最后一次性回放操作；应用前保存版本，天然获得撤销能力。

3. **工具即命令**  
   每个工具最终落到同一条命令层，不产生“Agent 专用旁路”，避免工程状态漂移。

4. **单一工具目录**  
   内置 Agent、外部 MCP、不同模型后端共用一套 Schema 和校验，减少能力漂移。

5. **运行账本 + 幂等键**  
   toolCallId + 参数摘要 + claim + 结果回传 + 租约，是长任务可靠性的基础。

6. **分层上下文压缩**  
   先做零成本机械修剪，再做模型摘要；按缓存表现调整阈值；压缩结果带哈希和来源工件。

7. **大结果工件化**  
   上下文只放引用和预览，模型用窄读工具按需取细节；这比“截断”更可控。

8. **渐进式工具/技能披露**  
   启动工具 + 关键词路由 + ToolSearch/load_skill 激活；技能只放索引，正文按需加载。

9. **能力清单进提示**  
   哪些供应商/能力已配置、哪些不可用、不可用时该走什么回退，直接写进系统提示，减少无效尝试。

10. **恢复优先的持久化**  
    会话代际、不可读保护、运行草稿、检查点完整性、事件游标、草稿恢复；默认假设“随时会刷新/崩溃”。

11. **审批模式与执行模式正交**  
    manual/auto 只决定“是否停下来确认”，不改变工具语义；ask 模式则直接裁剪工具面。

12. **可解释的 Agent UX**  
    操作卡片、影响描述、差分、验收结果、失败提示，让用户能判断 Agent 到底做了什么。

---

## 7. 证据索引

| 主题 | 关键文件 |
|---|---|
| 服务端 Agent 循环 | `server/agent-runs/executor.ts`、`server/agent-runs/context.ts`、`server/agent-runs/acceptance-loop.ts` |
| 运行事件与恢复 | `server/agent-runs/store.ts`、`server/agent-runs/sse.ts`、`server/agent-runs/routes.ts` |
| 工具桥 | `server/agent-runs/browser-tool.ts`、`src/agent/serverRunToolExecutor.ts` |
| 工具目录/校验 | `src/agent/tools.ts`、`src/agent/execution-policy.ts`、`src/agent/tool-activation.ts`、`src/agent/tool-routing.ts` |
| 系统提示 | `src/agent/systemPrompt.ts`、`src/agent/capabilities.ts`、`src/agent/settings/agentSettings.ts` |
| 草稿与提案 | `src/agent/external-edit-session.ts`、`src/agent/proposal.ts`、`src/agent/useAgentProposalActions.ts`、`src/agent/serverRunProposalLifecycle.ts` |
| 上下文压缩 | `src/agent/context-compaction.ts`、`src/agent/context-summary.ts`、`src/agent/context-checkpoint.ts`、`src/agent/context-management.ts` |
| 结果工件化 | `src/agent/runtime-artifact.ts`、`src/agent/tool-result-compaction.ts`、`src/agent/tool-result-output.ts` |
| 会话持久化 | `src/agent/useAgentPersistence.ts`、`src/persist/projectStore.ts`、`src/persist/agentRuntimeStore.ts`、`src/persist/agentRuntimeTypes.ts` |
| 运行账本 | `src/agent/runtime-ledger.ts`、`src/agent/runtime-ledger-serialization.ts`、`src/persist/agentRuntimeRetention.ts` |
| 工作状态/差分 | `src/agent/timelineDelta.ts`、`src/agent/context.ts` |
| MCP 服务端 | `server/external-agent/mcp.ts`、`mcp-tool-catalog.ts`、`mcp-tool-exposure.ts`、`mcp-controls.ts`、`mcp-prompts.ts` |
| MCP 工具权限 | `src/agent/external-tool-policy.ts`、`src/agent/external-tool-shape.ts`、`src/agent/external-tool-schemas.ts` |
| MCP 浏览器桥 | `server/external-agent/broker.ts`、`server/plugins/external-agent.ts`、`server/plugins/external-agent-bridge-routes.ts` |
| MCP 绑定/会话 | `server/external-agent/mcp-binding.ts`、`server/external-agent/mcp-session-status.ts`、`server/external-agent/builtin-approval-mode.ts` |
| 外部会话运行时 | `src/agent/external-bridge-runtime.ts`、`src/agent/external-run-ledger.ts`、`src/agent/external-approval-gate.ts` |
| 离线模式 | `server/external-agent/offline-runtime.ts`、`offline-tools.ts`、`offline-executor.ts` |
| 认证与 Token | `server/editor-auth.ts`、`server/mcp-token.ts`、`server/external-agent/client-connect.ts` |
| Skills | `src/agent/skills/plugin-skills.ts`、`src/agent/skills/skills-catalog.ts`、`src/agent/tools/plugin-skill-tools.ts` |
| Claude Code 特例 | `server/agent-runs/claude-code-turn.ts`、`server/claude-code/resume-store.ts` |

---

## 8. 最后一段判断

OpenChatCut 的 Agent 架构不是“让模型直接操纵一个视频编辑器”的简单封装，而是把 **Agent 的不确定性** 与 **专业编辑器的确定性** 用三层契约隔开了：

- 模型只输出意图与工具调用；
- 客户端用命令层把意图变成可验证、可撤销的操作；
- 用户用提案审批决定哪些操作进入真实工程。

它的“记忆”也不是一个神秘的黑盒，而是工程化的分层缓存：对话、摘要、工件、账本、草稿、工程事实各自有边界、有预算、有恢复路径。真正值得借鉴的不是某个阈值，而是这种 **“每一层记忆都可解释、可验证、可恢复”** 的设计态度。

MCP 则把这套契约开放给外部 Agent：不是开放数据库，也不是开放任意脚本，而是开放一套带会话、带草稿、带审批、带修订号、带幂等的工具协议。它的复杂度主要来自“浏览器不能接受入站连接”这一现实约束，以及“本地优先、单用户、可恢复”的产品定位；这也决定了它更像一个 **本地 Agent 工作台协议**，而不是通用多租户云服务。
