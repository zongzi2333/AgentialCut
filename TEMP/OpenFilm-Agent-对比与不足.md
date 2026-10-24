# OpenFilm Agent 对话问题复盘与 OpenCode 对比

> 依据：`TEMP/对话记录.txt`、当前 `studio/server` 的 Agent/分镜实现，以及 OpenCode 一类 coding agent 的通用架构。  
> 目标不是把 OpenFilm 改成编码助手，而是把"能理解、能规划、能调用工具、能验证、能恢复"的 Agent 机制补到视频工作流里。

## 一、对话记录暴露的问题与本次修复

| 对话中的表现 | 根因 | 本次处理 |
| --- | --- | --- |
| 用户说“根据内容自行决定各分镜时长”，AI 反问“请告诉我怎么分配” | 导演只被允许返回提案；本地 fallback 也只会解析明确的秒数，没有“按内容分配”的操作 | 增加 `distributeDurations`；AI/本地都直接生成完整操作；导演面板自动应用，不再要求二次确认 |
| 出现 `unknown storyboard operation: undefined` | 模型经常漏写 `type`，或使用 `setShotDuration`、`moveShot` 等自然名称；服务端只认固定 `type` | 增加操作别名、缺省类型推断、字段兼容；在服务端先整体验证，再返回/应用 |
| “保持开头三镜”没有实际效果 | 本地 fallback 不识别这个意图，模型也可能只回一段说明 | 增加 `lockShots`；本地 fallback 能直接锁定开头 N 个镜头 |
| “减少重复镜头”报 AI 分镜错误 | 没有去重工具；模型回复结构不稳定 | 增加按标题+旁白去重的本地操作，并扩展模型可用操作 |
| AI 回复了完整修改，界面却显示“这次修改没有通过校验 / This storyboard changed in another window” | `flush()` 每次都会保存一次未变化的文档，导致 revision 增加；随后按旧 `baseRevision` 应用 AI 操作，被 409 拒绝 | `flush()` 只在确实有未保存编辑时保存；修正后 AI 操作不会因为一次空保存而冲突 |
| 修改提案需要再次点“应用” | 旧设计把 AI 当“建议者”，不是“执行者” | 导演对话改为直接应用，撤销作为安全网；锁定镜头仍不可改 |
| 模型调用不可见，只能看到 HTTP 接口日志 | 旧日志记录的是 Studio 的 `/api/*` 请求 | 新增模型调用日志：Agent、provider、model、协议、耗时、token、请求、回复/错误 |

## 二、OpenCode 类 Agent 的关键实现

OpenCode 的 Agent 不是"一个更大的 prompt"，而是由几层职责分开的系统：

1. **Agent 定义**
   - 名称、mode（primary/subagent）、模型、系统提示、温度、最大输出、可用工具、权限规则。
   - 同一个模型可以通过不同 Agent 配置承担不同职责。
2. **工具注册表**
   - 每个工具都有名称、描述、输入 schema、执行函数和权限。
   - 模型返回的是结构化 tool call，不是自由文本；运行器负责校验、执行、把结果回填给模型。
3. **Agent Loop**
   - 模型思考 → 选择工具 → 执行 → 观察结果 → 继续，直到不再需要工具或达到停止条件。
   - 不是一次请求就结束；允许根据工具结果修正下一步。
4. **权限与审批**
   - 读、写、执行、网络等工具可以分别设为 allow / ask / deny。
   - 危险操作有明确边界；审批是运行时机制，不是提示词里的“请不要”。
5. **会话与上下文**
   - 会话持久化、消息历史、工具调用记录。
   - 上下文压缩/摘要、token 预算、长任务中的状态恢复。
6. **子 Agent**
   - 主 Agent 可以把一个明确子任务交给子 Agent，拿到结构化结果后继续。
   - 子 Agent 有独立上下文和工具权限，避免主上下文被污染。
7. **Skills / MCP / 插件**
   - Skills 按需加载，不把所有说明一次性塞进系统提示。
   - MCP 提供外部工具和资源；插件扩展事件、工具或 UI。
8. **可观测性**
   - 请求、工具调用、耗时、token、错误、子 Agent 链路都可追踪。
   - 日志服务于定位“是模型、提示词、工具还是权限的问题”。
9. **失败恢复**
   - 超时、限流、上下文溢出、工具失败有明确处理和重试策略。
   - 写入类操作有撤销/快照或提交边界。

## 三、OpenFilm 当前的 Agent 实现

当前 OpenFilm 已经有的基础是好的：

- `agent-cards.mjs`：五类固定工作位（分镜、导演、检索、画面审核、连续性），支持模型绑定、提示词、温度、token、skills。
- `agent-runtime.mjs`：统一 provider 协议，调用模型、注入挂载 skills。
- `pipeline.mjs`：串行流水线，持久化步骤、进度、取消、错误和连续性撤销。
- `storyboard.mjs`：分镜文档、候选匹配、VL 审核、受控操作和 handoff。
- `api-log.mjs` / `model-log.mjs`：本次增加了模型调用日志；能看出 Agent、模型、请求和返回。

但本质上仍是**“固定阶段 + 单次模型调用 + JSON 操作”**，不是通用 Agent Runtime。

## 四、对比：OpenCode 与 OpenFilm

| 维度 | OpenCode 类 Agent | OpenFilm 当前 | 差距/影响 |
| --- | --- | --- | --- |
| Agent 定义 | 配置化 agent，mode/model/prompt/tools/permission 分离 | 五张固定角色卡，主要是 prompt + model | 能换模型，难定义“新的工作方式” |
| 工具调用 | 工具注册表 + schema + 执行 + 观察循环 | 导演通过一次性 JSON operations 改分镜；`tools` 字段基本未参与运行时 | 模型不能在执行中查素材、试匹配、看结果再改 |
| 规划 | 多步 plan，可调用工具后调整 | pipeline 固定五步；导演一次回复 | 复杂任务容易“一口吃”，缺少中间验证 |
| 权限 | allow/ask/deny、按工具/路径配置 | 只有锁定镜头和撤销；没有工具级审批 | AI 能做什么由代码写死，不可按任务收紧 |
| 会话 | 持久化 session、历史、工具记录、压缩 | 导演消息只在当前页面内存；刷新丢失 | 无法连续多轮围绕同一分镜深入 |
| 上下文 | token 预算、摘要、裁剪、子上下文 | 每次把当前分镜 JSON 塞进提示；没有预算/压缩 | 长片、多镜头后上下文容易过大或丢重点 |
| 子 Agent | 可派生子任务并回收结构化结果 | 只有五阶段串行，无动态委派 | 检索、审片、装配不能按需深入 |
| Skills | 渐进式加载、资源/脚本/权限 | 支持挂载 skill，但整段注入 system prompt | 可用，但上下文成本和权限边界粗 |
| MCP/插件 | 标准外部工具生态 | 没有 MCP；provider 主要是模型/媒体 | 无法接入外部剪辑、资产、审片系统 |
| 模型路由 | 多 provider、fallback、usage/成本 | 每张卡绑定一个模型；无自动降级/路由 | 一个模型失败就中断；成本不可控 |
| 可观测性 | 完整 trace、工具 span、子 Agent 链路 | 刚有模型调用日志；无工具/流水线 trace 树 | 能看单次请求，难定位多步问题 |
| 评测 | 回归用例、工具调用评测、提示词版本 | 有少量服务测试；没有 Agent 行为回归集 | 改 prompt/模型后容易“感觉变好/变坏” |
| 失败恢复 | 超时/限流/上下文/工具错误分层处理 | pipeline 有取消和连续性 undo；AI 操作冲突刚修 | 多步任务中断后恢复能力弱 |
| 交互 | 流式输出、审批、可中断工具 | 单次等待；只有运行/历史标签 | 长任务反馈不足，用户不知道 AI 在做什么 |

## 五、最需要补的不足（按优先级）

### P0：让“操作”成为真正的工具

当前 `operations` 只是 JSON 数组，模型只能猜字段。建议把每个操作注册成工具：

- `update_shot`
- `set_shot_duration`
- `distribute_durations`
- `delete_shot`
- `duplicate_shot`
- `move_shot`
- `set_match`
- `clear_match`
- `rematch_shots`
- `lock_shots`
- `update_scene`
- `add_scene`

每个工具带 JSON Schema、说明、示例、权限和结果。模型返回 tool call，服务端校验后执行，再把“执行结果/失败原因”回填给模型；模型可以据此继续修正，而不是一次性生成一坨 Operations。

### P0：把导演对话做成 Agent Loop

最小闭环：

1. 读取当前分镜和选中镜头。
2. 模型决定：直接回答，还是调用一个或多个工具。
3. 工具执行后把结果（新时长、匹配候选、失败镜头）返回模型。
4. 模型继续，直到完成。
5. 每次写入前做权限检查，写入后保留 undo 快照。

这样“减少重复镜头”可以先查重、再删、再报告删了哪几个；“调整节奏”可以先看每镜内容、再分配、再检查总时长。

### P1：会话与上下文

- 导演对话按项目持久化（至少 `.film/agent-sessions.json`）。
- 每轮只带相关镜头、最近操作、未解决缺口；不要每次塞全片 JSON。
- 增加 token 预算和自动摘要；长片先摘要场景，再展开选中镜头。
- 记录工具调用和结果，刷新后仍能看到“AI 做了什么”。

### P1：权限与安全边界

- 工具级 allow/ask/deny；例如 `delete_shot` 默认 ask，`set_shot_duration` 默认 allow。
- 批量操作/跨项目写入 ask。
- 锁定镜头、锁定轨道、只读素材库作为硬约束，而不是只靠提示词。
- 审批 UI 与撤销快照绑定。

### P1：可观测性升级

刚刚的模型调用日志是第一步，下一步应记录：

- 一次用户请求的 trace ID。
- 模型调用 → 工具调用 → 工具结果 → 再调用 的树。
- 每个步骤的 token、耗时、重试、错误。
- 哪个 Agent/子 Agent 产生的结果。
- 页面里能按 trace 查看，而不是只按时间平铺。

### P2：子 Agent 与评测

- 检索 Agent 子任务：给定镜头，返回 3 组查询词和候选评估。
- 审片 Agent 子任务：只处理一个候选，返回结构化 verdict。
- 连续性 Agent 子任务：只检查相邻镜头。
- 为“减少重复/调整节奏/保持开场/补缺镜/换素材”建立固定评测用例，记录模型输出和最终 diff。

## 六、建议的 OpenFilm Agent 目标结构

```text
AgentRuntime
  ├─ AgentDefinition (role, model, prompt, tools, permissions)
  ├─ SessionStore (project + agent + messages + trace)
  ├─ ContextBuilder (selected shots, scene summaries, token budget)
  ├─ ModelRouter (provider/model/fallback/usage)
  ├─ ToolRegistry
  │    ├─ storyboard.*  (typed operations)
  │    ├─ media.*      (search, match, preview, import)
  │    ├─ pipeline.*   (run, cancel, inspect)
  │    └─ project.*    (read-only facts)
  ├─ PermissionGate (allow/ask/deny)
  ├─ AgentLoop (model ↔ tools, stop conditions)
  ├─ TraceRecorder (model + tool spans)
  └─ Undo/Recovery (snapshot before writes)
```

对 OpenFilm 来说，不需要照搬 coding agent 的 shell/文件工具；需要的是同样的**工具化、循环、权限、会话、trace、恢复**六件事。

## 七、本次已落地的最小改进

- 导演 AI 直接修改，不再让用户二次确认；撤销兜底。
- 操作别名与缺省 type 兼容，修掉 `unknown storyboard operation: undefined`。
- 增加按内容分配时长、去重、锁定开头、复制/移动/场景编辑等操作。
- 修复 AI 应用时的 revision 冲突（空 flush 不再增加 revision）。
- 模型调用日志替代 HTTP 接口日志。
- 分镜卡片的外部点击收起、双击详情、横向 2× 展开（预览在上、详情在下）。
- 粗剪按目标时长裁剪素材，不再把整个源文件导入剪辑。
- 素材库/素材篮不再受“语义检索候选数 16”限制，只有语义检索受此限制。
- 素材描述（desc）惰性生成：素材库按钮显式生成；导演引用/选中素材或 VL 审核发送素材时自动补全并保存，已有描述不会被覆盖。

后续真正决定 Agent 上限的，不是再写更长的提示词，而是把“能做什么”变成可校验、可授权、可观察、可回滚的工具。
