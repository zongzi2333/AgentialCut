# OpenCode、OpenFilm 本项目、openfilm-raw 的 Agent 设计对比

> 范围：`D:\Tools\openfilm`（本项目，0.2.4 + 分镜/内置 Agent 改造）、`D:\Tools\openfilm-raw`（上游 0.2.5 原始工程）、OpenCode 1.17.x（本机安装的 coding agent）。
>
> 界面参考：`D:\OpenFilm`（已安装的 0.2.4 桌面版）。它的 AI 聊天位于右侧独立列，由 Electron shell 提供；本项目桌面版沿用同一套 host panel，浏览器版则使用项目内自建的简化右栏。
>
> 目的：不是判断谁“更先进”，而是分清三套 Agent 各自解决什么问题、边界在哪里，以及本项目下一步该借鉴什么、不该照搬什么。

## 一、一句话结论

| 项目 | Agent 的定位 | 核心形态 |
| --- | --- | --- |
| OpenCode | 通用 coding agent 运行时 | Agent 定义 + 工具注册表 + 多轮工具循环 + 会话/权限/MCP/Skills |
| 本项目 | 视频分镜流水线里的“专业岗位” | 五张固定角色卡 + 提供商/模型 + 单次 JSON 调用 + 服务端校验 |
| openfilm-raw | Studio 旁边的“外部 coding agent 工作台” | ACP 接入 Claude Code/Codex/OpenCode 等 + 会话、技能、MCP、日志 |

三者都叫 Agent，但不是同一层东西：OpenCode 是**运行时**，openfilm-raw 是**运行时宿主/编排器**，本项目当前更像**领域工作流中的模型调用层**。

## 二、OpenCode 的 Agent 设计

### 2.1 结构

OpenCode 把 Agent 做成可配置的执行主体：

- **Agent 定义**：名称、模式（primary/subagent）、模型、系统提示、温度、可用工具、权限。
- **工具注册表**：每个工具都有名称、说明、参数 schema、执行函数和权限边界；模型返回结构化 tool call，运行时校验后执行，再把结果作为 observation 送回模型。
- **Agent Loop**：模型思考 → 选择工具 → 执行 → 读结果 → 继续，直到回答完成、达到停止条件或需要用户确认。
- **权限**：读、写、执行、网络等可以分别 allow/ask/deny；危险操作有明确边界，不能只靠提示词约束。
- **会话**：消息历史、工具调用记录、压缩/摘要、token 预算、刷新后的状态恢复。
- **子 Agent**：把明确任务交给另一个 Agent，返回结构化结果；子 Agent 可以有独立模型、提示和权限。
- **扩展**：Skills（按需加载的说明/脚本）、MCP（外部工具与资源）、插件、Provider 路由。
- **可观测性**：请求、工具调用、耗时、token、子 Agent 轨迹；失败可定位到具体模型/提示/工具/权限。
- **失败恢复**：超时、重试、工具错误、上下文压缩、会话恢复。

### 2.2 本机配置反映出的实际用法

本机 OpenCode 配置中可以看到：

- 多个 OpenAI-compatible provider，以及按模型配置的上下文/输出上限；
- `agent.explore`、`agent.general` 被显式禁用，说明 Agent 是按任务裁剪的，不是全部常驻；
- MCP 服务器可以逐个启用/禁用（ChatCut、Blender、剪映、DaVinci Resolve、Spine 等）；
- oh-my-opencode-slim 把 orchestrator、oracle、librarian、explorer、designer、fixer 等角色分配到不同模型/推理强度；
- Skills 和 MCP 都是运行时装配，而不是写死在代码里。

这说明 OpenCode 的设计重点不是“一个万能 prompt”，而是**把职责、工具、模型、权限拆开，由运行时组合**。

## 三、本项目的 Agent 设计

### 3.1 五张角色卡

`studio/server/agent-cards.mjs` 定义了五个工作槽：

| 角色 | 职责 | 产出 |
| --- | --- | --- |
| `storyboard` | 把脚本/一句话拆成分镜 | `title/brief/scenes/shots` JSON |
| `director` | 把自然语言变成受控修改 | `reply + operations` JSON |
| `query` | 为镜头生成检索词和硬条件 | 查询 JSON |
| `verify` | 用视觉模型审核候选画面 | 候选 verdict/confidence/reason/desc |
| `continuity` | 检查重复、节奏、景别、顺序 | issues + 有限 operations |

每张卡包含：启用的模型/提供商绑定、system prompt、temperature、maxTokens、topP、tools、skills。一个角色最多一个启用卡，避免同一工作槽出现两个互相矛盾的 Agent。

### 3.2 运行时

- `agent-runtime.mjs` 把 Provider Card（协议、Base URL、Key、模型）和 Agent Card（提示、采样、技能）合并成一次模型调用。
- 支持 Anthropic Messages、Gemini generateContent、OpenAI Responses、OpenAI Chat Completions 等协议。
- 调用的输入输出记录到 `model-log.mjs`：角色、Agent、provider、model、协议、耗时、tokens、请求、回复/错误。
- 挂载的 Skills 在调用前读取，追加到 system prompt；被删除的 skill 跳过，不让整次运行失败。
- `parseJsonReply` 负责从纯文本、代码围栏或第一个 JSON 对象中恢复结构化结果。

### 3.3 流水线与安全边界

`pipeline.mjs` 把粗剪拆成固定阶段：

1. 生成/转换分镜
2. 检索规划
3. 匹配素材
4. 画面审核
5. 连续性检查

每阶段结束保存分镜；失败保留已完成的阶段和失败位置。服务端对 AI 返回的 `operations` 做白名单校验，锁定镜头不可改；连续性修改前保存 undo 快照。

本项目的 AI 编辑是**直接应用 + 撤销兜底**，不要求用户二次确认；这适合明确的分镜操作，但也意味着服务端校验必须足够强。

### 3.4 本项目的本质

它不是一个通用工具循环，而是：

> 固定领域工作流 + 每阶段一次模型调用 + JSON 协议 + 服务端校验。

优点是可控、可测试、成本低、不会让模型随意调用文件/命令；缺点是没有多轮工具反馈，模型一次没算对就只能重试或人工修。

### 3.5 剪辑页聊天的位置

- 桌面版（`D:\OpenFilm` 与 `apps/desktop`）的聊天是 Electron shell 的右侧独立列，Studio 通过 `hostPanel` 让出宽度；这列支持会话、模型选择、附件、Studio 引用、Skills/MCP、权限/问题、turn log 等，功能比浏览器自建面板丰富。
- 浏览器 Studio 没有 Electron/ACP，因此保留一个按项目配置模型调用的右栏；它现在是固定右栏而不是悬浮窗。窗口不够宽时，检查器先让位，保证画面与聊天都能用。
- 桌面版使用原生聊天列时，浏览器自建面板会隐藏，避免出现两个 AI 对话。

## 四、openfilm-raw 的 Agent 设计

### 4.1 Studio 本身不带模型 Agent

上游 0.2.5 的 Studio 是确定性的本地剪辑器：读写 `film.html`、时间线、素材、导出。它没有本项目那套 Agent Card / Provider Card / `callAgent`。

AI 能力在桌面版的**右侧聊天栏**里：

- `apps/desktop/shell/bridge.ts`：把 Studio 和聊天放进同一页面；Studio 通过 `window.openfilmHost` 获得 `panel`、`refer`、`selection`、`tabs` 等能力。
- `apps/desktop/chat`：会话、消息、附件、引用、模型菜单、停止/继续、问题/权限卡片、变更列表、turn log。
- `apps/desktop/src/local-agents-ipc.mjs`：启动并管理外部 Agent 进程，走 ACP（Agent Client Protocol）。
- `apps/desktop/src/agent-roster.mjs`：发现、连接、断开、显示/隐藏、模型与用量。
- `apps/desktop/src/agent-skills.mjs`：把项目 Skill、个人 Skill、官方 Skill、Agent 自己的 Skill 和 MCP 服务器装配进一次会话。
- `apps/desktop/src/chat-store.mjs` / `agent-records.mjs`：会话、turn、日志、模型请求记录。

### 4.2 外部 Agent 是“真正的主角”

openfilm-raw 支持 Claude Code、Codex、GitHub Copilot、Cursor、OpenCode、CodeBuddy、Qwen Code、Kimi、MiniMax Code、DeepSeek Harness，以及“自己的 Key”（Pi）。

这意味着：

- Agent 的循环、工具、文件编辑、Shell、MCP、上下文压缩、权限，由各 Agent 自己实现；
- OpenFilm 负责**宿主**：项目上下文、Studio 引用、图片、附件、会话保存、技能过滤、日志、UI；
- Agent 直接修改项目文件，Studio 通过文件监听刷新画面；
- 失败、权限、问题、模型调用都回到聊天栏，用户始终看得见。

### 4.3 相似点

- 都把 Agent 和模型/提供商解耦；
- 都重视 Skills；
- 都有会话/运行状态；
- 都记录模型调用或 turn log；
- 都允许用户干预（停止、权限、问题、重试）；
- 都把“项目文件夹”作为 Agent 的工作目录和事实来源。

### 4.4 关键不同

| 维度 | OpenCode | 本项目 | openfilm-raw |
| --- | --- | --- | --- |
| Agent 在哪 | 独立运行时/CLI | Studio 服务端进程内 | Electron 主进程 + 外部 Agent 进程 |
| Agent 类型 | 通用 coding agent | 五个视频岗位 | 用户已有的 coding agent |
| 工具调用 | 多轮 tool loop | 一次 JSON operations | Agent 自己的工具循环 |
| 规划 | 模型自行规划 | 固定五阶段 | Agent 自行规划 |
| 权限 | allow/ask/deny | 服务端操作白名单 + 锁定镜头 | ACP 权限请求 + Studio/宿主边界 |
| 会话 | 原生持久化/压缩 | 当前主要是页面/请求上下文 | 每项目 `.film/chat` + turn 记录 |
| Skills | 运行时加载 | 挂载进 system prompt | 按 Agent 能力注入/过滤 |
| MCP | 原生 | 当前没有 | 原生支持，按 Agent 过滤 |
| 可观测性 | 请求/工具/子 Agent trace | 模型调用日志 | turn log + Agent 自己的记录 |
| 失败恢复 | 重试/压缩/会话恢复 | 阶段重试 + undo 快照 | Agent 自己恢复 + 会话续接 |
| 适用边界 | 任意代码任务 | 分镜/素材/粗剪 | 在真实项目里做片子 |

## 五、openfilm-raw 聊天栏“消失”的修复

这次在 `openfilm-raw` 做了四层防护，而不是只改一个 CSS：

1. **启动就有内容**
   - `apps/desktop/chat/src/mount.tsx` 在等待 `app.hello()` 时先渲染“正在打开 AI 对话”，不再留下一个透明空列。
   - 15 秒未连上则显示“AI 对话暂时不可用”，带“重试”，避免永久空白。

2. **不再只认一次地址**
   - `apps/desktop/shell/bridge.ts` 记住最近一次项目地址；`pageshow`、窗口尺寸变化、第一帧布局后都会重新放置聊天列。
   - `shownWidth()` 在窗口尚未完成布局、`innerWidth` 为 0 时回退到保存的宽度，避免宽度被算成 0。

3. **聊天开关始终找得到**
   - Studio 顶栏新增直接的聊天按钮（有 host panel 时显示），不必打开 Layout 菜单才能把聊天找回来。
   - `aria-pressed` 反映当前开关状态。

4. **IPC 边界更稳**
   - `fromPage()` 在 Electron 未提供 `senderFrame`（或 frame 已销毁）时，仍以“这个 WebContents 属于某个 tab 的主 frame”为边界，避免聊天 IPC 被误判为非页面请求而整块不工作。

需要说明：如果用户之前主动关闭过聊天，`chatOpen:false` 会被保存；新版顶栏按钮和 Layout 菜单都能重新打开。若聊天数据本身损坏，启动失败态现在会明确显示并允许重试，而不是静默消失。

## 六、对本项目的建议

### 6.1 应该借鉴 OpenCode 的

- **工具化 operations**：把当前的 JSON operations 做成带 schema 的工具，让模型可以“改一步 → 看结果 → 再改一步”；服务端仍然做校验。
- **会话与 trace**：给导演对话保存会话和每轮操作 trace，刷新后能继续，也能解释“AI 为什么这么改”。
- **权限分层**：删除镜头、锁定/解锁、批量重排等操作分级；高风险操作可 ask，普通改时长/文案可 allow。
- **上下文预算**：不要每次把整份分镜 JSON 全塞进去；按选中镜头、场景摘要、候选素材做裁剪。
- **子 Agent**：检索/审核/连续性可以并行或独立重试，不必串成一条长链。

### 6.2 不应该照搬的

- 不要把 Studio 变成通用 shell agent；视频编辑需要确定性的操作协议和可撤销边界。
- 不要让模型直接写 `film.html` 绕过 Storyboard/时间线校验；这会破坏锁定镜头、素材引用和 undo。
- 不要为了“Agent 感”引入无边界的工具调用；本项目最有价值的部分恰恰是**服务端可验证的操作**。

### 6.3 与 openfilm-raw 的关系

- openfilm-raw 的桌面聊天适合“让外部 coding agent 直接做片子”；
- 本项目的五角色流水线适合“在 Studio 内做受控的分镜/粗剪”；
- 两者不是替代关系：可以把 openfilm-raw 的 ACP/会话/技能装配经验拿来做本项目的“外部 Agent 模式”，同时保留本项目自己的确定性分镜层。

## 七、验证记录

- `openfilm-raw/apps/desktop/src/project-bridge.test.mjs`：10/10 通过（借用本项目的 TypeScript 依赖临时运行，运行后已移除链接）。
- 修改文件通过 TypeScript `transpileModule` 语法检查：
  - `apps/desktop/shell/bridge.ts`
  - `apps/desktop/chat/src/mount.tsx`
  - `apps/desktop/chat/src/i18n/locales/en-US.ts`
  - `apps/desktop/chat/src/i18n/locales/zh-CN.ts`
  - `packages/openfilm/studio/ui/src/components/ProjectView.tsx`
- 未运行 `pnpm --filter @openfilm/desktop typecheck` / `build:shell`：`openfilm-raw` 没有安装 `node_modules`，按“由用户操作服务”的约定没有启动或安装。

## 八、涉及文件

### 本项目
- `packages/openfilm/studio/server/agent-cards.mjs`
- `packages/openfilm/studio/server/agent-runtime.mjs`
- `packages/openfilm/studio/server/pipeline.mjs`
- `packages/openfilm/studio/server/model-log.mjs`
- `packages/openfilm/studio/server/storyboard.mjs`

### openfilm-raw
- `apps/desktop/shell/bridge.ts`
- `apps/desktop/chat/src/mount.tsx`
- `apps/desktop/chat/src/App.tsx`
- `apps/desktop/chat/src/app-bridge.ts`
- `apps/desktop/chat/src/lib/chat-store.ts`
- `apps/desktop/src/local-agents-ipc.mjs`
- `apps/desktop/src/agent-roster.mjs`
- `apps/desktop/src/agent-skills.mjs`
- `apps/desktop/src/menu.mjs`

### OpenCode
- 本机 `opencode-ai` 1.17.x
- 本机 `~/.config/opencode/opencode.jsonc`
- 本机 `~/.config/opencode/oh-my-opencode-slim.json`
- OpenCode 的 Agent / Tool / Session / Permission / MCP / Skills 运行时设计

## 九、流程图文件（draw.io）

- `D:\Tools\TEMP\opencode-agent-flow.drawio`
  - OpenCode：Agent 定义 → 上下文 → 模型 → 工具/权限循环 → 回答/会话。
- `D:\Tools\TEMP\openfilm-project-agent-flow.drawio`
  - 本项目：输入 → 五阶段流水线 → 角色卡/模型/JSON 校验 → 分镜文档/粗剪/撤销。
- `D:\Tools\TEMP\openfilm-raw-agent-flow.drawio`
  - openfilm-raw：Studio + 右侧聊天列 → shell bridge → ACP 外部 Agent → 工具/MCP/Skills → 项目文件 → Studio 刷新。

三份文件均使用 draw.io 的 `mxfile > diagram > mxGraphModel` 格式，中文标注，可直接用 draw.io / diagrams.net 打开后继续排版。
