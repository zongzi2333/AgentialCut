# OpenFilm 统一 Agent 与 MCP 设计方案

> 目标：项目中只保留一套 Agent 业务逻辑；Studio 内对话、桌面 App 对话、外部 ACP Agent 都通过同一组受控工具修改影片。  
> 当前范围：先实现可用、通用、可验证的最小闭环；更完整的 MCP 能力在本文末尾列出，后续迭代补全。

## 1. 结论

1. **一套 Agent 流程**：`流程控制器（确定性） → storyboard / material / edit / qc / conversation` 五个工作槽。角色不再是多套聊天入口，而是同一流程中的职责。
2. **一套对话接口**：`POST /api/projects/:id/agent/chat`。故事板面板和剪辑面板都调用它，只通过 `scope: "storyboard" | "edit"` 区分上下文。
3. **一套工具层**：`agent-tools.mjs` 同时服务 Studio 对话与 MCP。工具只读写 OpenFilm 文档，不直接改 `film.html`、不渲染、不导出。
4. **外部 Agent 走 MCP**：桌面端在 ACP `session/new` 的 `mcpServers` 中注入项目级 `openfilm` HTTP MCP Server；指令同时明确“不要直接改文件”。
5. **App 自有 Agent 也走同一 MCP**：Pi 没有原生 `mcpServers` 开关，因此由 `mcp-tools.mjs` 将它转成 Pi 工具。
6. **最终渲染、导出由用户操作**：Agent 没有 render/export 工具。
7. **TTS、配乐暂不实现**：没有对应工具；等音效界面实现后再补。
8. **自动质检保留**：流水线 `verify` 阶段使用 `qc`，连续性阶段使用 `edit`；另提供确定性 `qc` 工具。

## 2. 角色与流水线

### 2.1 工作槽

| 槽位 | 职责 | 旧角色迁移 |
| --- | --- | --- |
| `storyboard` | 解析输入、分镜、预检、结构修复 | `storyboard` |
| `material` | 检索词、硬条件、候选、素材缺口 | `query` |
| `edit` | 粗剪、时间线装配、连续性、EDL | `continuity` |
| `qc` | 画面审核、重复/节奏/风险、自动质检 | `verify` |
| `conversation` | 自然语言对话，调用受控工具直接修改 | `director` |

- `agent-cards.json` 在原地迁移：角色名映射、旧默认提示词替换、旧模型绑定保留；自定义提示词不覆盖。
- 每个槽位最多一个启用卡片；重复启用时后来的卡片保留但暂停。
- 旧的 `storyboard/chat`、`edit/chat` 接口已删除；前端统一调用 `agent/chat`。

### 2.2 当前五阶段

| 阶段 ID | 名称 | 使用槽位 |
| --- | --- | --- |
| `generate` | 生成/转换分镜 | `storyboard` |
| `query` | 素材检索 | `material` |
| `match` | 匹配候选 | 确定性匹配 + `material` |
| `verify` | 自动质检 | `qc` |
| `continuity` | 剪辑连续性 | `edit` |

保留阶段 ID 是为了历史、UI 和 run 文件兼容；只改语义和角色，不增加未实现的阶段。

## 3. 对话接口

`POST /api/projects/:id/agent/chat`

```json
{
  "text": "把开头三镜压紧，删掉重复镜头",
  "scope": "storyboard",
  "selectedIds": ["shot_..."],
  "selectedClipIds": ["clip_..."]
}
```

故事板返回值：

```json
{
  "reply": "好的。",
  "operations": [{ "type": "deleteShot", "shotId": "shot_..." }],
  "proposal": { "id": "proposal_...", "baseRevision": 12, "source": "ai" },
  "intent": "edit"
}
```

剪辑返回值：

```json
{
  "reply": "已把两段对调。",
  "applied": true,
  "rev": "8c1f...",
  "timeline": { "clips": [], "durationMs": 12000 }
}
```

- 故事板沿用现有“返回操作 → 前端 apply → 撤销栈”边界；服务端返回前会先 `applyOperations` 验证。
- 剪辑由服务端调用 `editProjectFilm` 校验并写入，前端刷新预览；撤销仍由 Studio 的版本/编辑历史承担。
- 模型输出不是 JSON 时，只作为普通回答，不执行任何修改。

## 4. MCP Server

### 4.1 地址与认证

```
POST http://127.0.0.1:<studio-port>/api/projects/<project-id>/mcp
Authorization: Bearer <mcp-key>
Content-Type: application/json
```

- MCP 使用独立的会话密钥；它只在 MCP 路径上有效，不能用于导出/渲染。Studio 自己的 API 仍使用 `x-studio-key` 或启动 Cookie。
- 工具按阶段收敛：分镜交接后，`read_storyboard` 与 `edit_storyboard` 从 MCP 工具列表中移除，编辑阶段只保留时间线、项目文件、质检、检索与撤销工具。
- 无状态 JSON-RPC，支持单个请求与 batch。
- 支持 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`、`resources/list`、`prompts/list`。

### 4.2 当前工具

| 工具 | 作用 | 限制 |
| --- | --- | --- |
| `read_project` | 项目、分镜、时间线摘要 | 只读 |
| `read_storyboard` | 完整分镜 | 只读 |
| `read_timeline` | 轨道、clip id、trim、位置、checked film | 只读 |
| `search_materials` | 语义素材检索 | 不自动挂载 |
| `edit_storyboard` | 按 shot/candidate id 修改分镜 | 锁定镜头不可改；revision 冲突返回 409 |
| `edit_timeline` | 按 clip id 修改时间线 | 由 `applyOps`/`readFilm` 校验；保存一步撤销快照 |
| `undo_timeline` | 恢复上一次 `edit_timeline` 前的时间线 | 只对 MCP 工具编辑有效 |
| `qc` | 确定性自动质检 | 只报告，不修改 |
| `preview` | 告知用户看 Studio 预览 | 不渲染 MP4 |

**没有** `render`、`export`、`tts`、`music` 工具。

### 4.3 外部 ACP 注入

桌面端在 `local-agents-ipc` 启动 Agent 时，根据 `cwd` 找到项目 id，生成：

```js
{
  type: 'http',
  name: 'openfilm',
  url: `${studio.origin}/api/projects/${id}/mcp`,
  headers: [{ name: 'Authorization', value: `Bearer ${studio.mcpKey}` }]
}
```

该对象进入 ACP `session/new`、`session/load`、`session/resume` 的 `mcpServers`。turn log 只记录服务器名和 URL，headers 明确脱敏为 `[hidden]`，不写密钥。

### 4.4 Pi（App 自有 Agent）

`pi-agent.mjs` 从 ACP `session/new` 拿到同一 `mcpServers`，由 `mcp-tools.mjs` 执行 `initialize` / `tools/list`，把工具注册为 Pi 工具。MCP 不可达时只跳过这些工具，不让整个会话启动失败。

## 5. 权限边界

| 能力 | Studio 对话 | 外部 ACP Agent | App 自有 Agent |
| --- | --- | --- | --- |
| 读分镜/时间线 | 是（上下文） | 是（MCP） | 是（MCP） |
| 改分镜 | 是（受控 operations） | 是（`edit_storyboard`） | 是（`edit_storyboard`） |
| 改时间线 | 是（受控 filmOps） | 是（`edit_timeline`） | 是（`edit_timeline`） |
| 自动质检 | 是 | 是（`qc`） | 是（`qc`） |
| 渲染/导出 | 否 | 否（无工具） | 否（无工具） |
| TTS/配乐 | 否（未实现） | 否（未实现） | 否（未实现） |
| 直接改项目文件 | 否 | **无法硬性禁止**（Agent 自带 shell/文件工具） | Pi 仍保留页面/媒体编辑工具 |

外部 Agent 仍可用自己的文件工具创建/修改页面、素材等；但 `film.html` 与 `.film/storyboard.json` 必须通过 MCP 工具修改。

外部 Agent 的 shell 与文件工具是宿主程序的，MCP 不能硬隔离。当前策略是：

1. 只提供受控工具；
2. 系统提示与首条消息明确禁止直接改 `film.html` / `.film/storyboard.json`，禁止渲染/导出；
3. 工具返回的 revision 冲突必须重新读取，避免覆盖；
4. 后续可在外层 ACP 权限层做更强的拦截。

MCP 的 `Authorization` 头使用独立的 MCP 会话密钥，不是 Studio 的编辑器密钥；它只在 `/api/projects/<id>/mcp` 上有效，不能用来调用导出/渲染。桌面 App 每次启动生成随机 MCP 密钥。密钥只放在请求头中，OpenFilm 的 turn log 脱敏为 `[hidden]`；但外部 Agent 自己的日志/配置可能记录它，这是 ACP 宿主侧的残留风险，不能由 Studio 单方面消除。MCP 密钥本身泄露的最坏结果是可改分镜/时间线，不能执行最终渲染或导出；但外部 Agent 若有 shell 且能读到 `run.json`，仍可能取得 Studio 编辑器密钥，因此这是“受控工具 + 指令”而非强沙箱。

## 6. 自动质检

- 流水线 `verify` 阶段：`qc` 角色看候选关键帧，输出通过/不确定/失败与理由。
- 流水线 `continuity` 阶段：`edit` 角色检查重复、节奏、景别和顺序，只应用安全的结构修改。
- MCP `qc` / 对话工具：确定性检查空分镜、无候选、未选素材、复核、缺口、重复素材、目标时长偏差、时间线为空。
- 不做最终渲染质检；渲染是用户操作。

## 7. 撤销与一致性

- 分镜：沿用现有 `storyboard/apply` 与前端撤销栈；服务端在返回前验证 operations。
- 时间线：写入前校验 revision；写入后由 Studio 的文件监听刷新；`edit_timeline` 在 `.film/agent-undo.json` 保存一步快照，MCP `undo_timeline` 可恢复。
- 并发：`edit_timeline` 按 clip id 重放，缺失 clip 整体失败，不落到另一个 clip。
- 版本历史：Git 版本历史仍是用户的长期恢复手段。
- 待补：Studio 对话面板的一键“撤销上一轮”按钮；当前时间线可用 MCP `undo_timeline` 或 Studio 编辑/版本历史恢复。

## 8. 已删除 / 保留

删除：

- 旧 `/storyboard/chat`、`/edit/chat` 路由；
- 旧 `AiPanel.tsx`、`RoughCutStage.tsx` 未使用入口；
- 旧 `director/query/verify/continuity` 作为运行时角色名（仅迁移映射保留）。

保留：

- `DirectorPanel`（故事板右侧对话）与 `EditChatPanel`（剪辑右侧对话），布局不变；
- 五阶段 ID 与 run/history 兼容；
- `storyboard/apply`、`storyboard/handoff`、手动导出流程。

## 9. 后续 MCP 工作

1. **时间线撤销**：每轮写入前保存快照，增加 `undo_timeline` 工具/按钮。
2. **工具细化**：`add_clip`、`set_transition`、`edit_subtitle` 等拆分，减少模型直接拼 `filmOps`。
3. **素材落位**：`attach_material` 把检索结果直接挂到 shot/candidate，仍需用户确认。
4. **音频**：TTS、配乐、音效在音效界面实现后，再增加独立工具与权限；不与当前阶段混用。
5. **渲染**：即使未来提供，也应只允许用户从 Studio 触发；Agent 最多给参数建议，不执行。
6. **强边界**：探索 ACP 外层工具白名单/权限拦截，减少对外部 Agent 自带 shell 的依赖。
7. **MCP 传输**：当前只有 HTTP JSON；如需 SSE 流式或 stdio，可新增适配层，不改变工具注册表。
8. **可观测性**：为 MCP 调用增加与 Studio 模型日志同级的工具调用日志（脱敏）。

## 10. 验证

```bash
pnpm --filter openfilm typecheck
pnpm --filter openfilm build:ui
node --test packages/openfilm/studio/server/storyboard.test.mjs
node --test packages/openfilm/studio/server/ops.test.mjs
```

MCP 冒烟：

```js
// 使用项目 id 与 Studio key
POST /api/projects/<id>/mcp
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

## 11. 已知环境问题

- 本机 `apps/desktop` 未安装 workspace 依赖时，桌面测试会因缺少 `@agentclientprotocol/sdk`、`openfilm`、`diff` 等报错；这不是本次代码错误。安装依赖后再跑桌面 `typecheck` / `test`。
- `pnpm --filter openfilm test` 的个别既有用例依赖本机代理/浏览器/偏好状态；本次只以 `typecheck`、UI build、故事板与 ops 定向测试为准。
