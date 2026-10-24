# OpenFilm AI 对话剪辑：分析、复现原型与参考资料

本文件夹整理了对 `D:\OpenFilm`（OpenFilm Desktop 0.2.4）剪辑 Agent 的分析，以及一个可单独打开、可交互的复现原型。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `OpenFilm-AI剪辑Agent设计分析.md` | 完整分析：ACP 宿主、agent 运行时、Studio 引用、文件监听、`film.html` 数据模型、界面设计、复现蓝图与验收清单 |
| `OpenFilm-AI对话剪辑界面.html` | **先看这个**。单文件、无依赖、可双击打开的可交互原型：Studio 界面 + AI 对话 + 时间线联动 |
| `OpenFilm-AI对话剪辑界面-预览.png` | 原型界面预览 |
| `OpenFilm-Studio-原始index.html` | 安装包中 Studio 的原始构建入口（引用 `/assets/...`，不是独立页面） |
| `OpenFilm-桌面壳-原始index.html` | 安装包中“Studio + 对话”桌面壳的原始构建入口 |
| `OpenFilm-Studio-实机截图.png` | 实际加载 `D:\OpenFilm` 的 Studio 后的界面截图 |

## 快速开始

1. 双击 `OpenFilm-AI对话剪辑界面.html`。
2. 点击时间线上的 `feature` 片段，按 `Ctrl+L`（macOS 为 `⌘L`），composer 会出现引用 pill。
3. 输入：
   ```text
   开头还是太平，标题再提前一点，第一段缩到 3 秒，加一个推近。
   ```
   可以看到 mock ACP agent 的工具行、`openfilm look`、回复、`film.html +3 −3`，时间线和画面同步变化。
4. 输入“删除第二句旁白”，会出现权限卡片；输入“你觉得哪里最该改？”，会出现方向选择卡片。
5. 点击回复下方的终端图标，可以查看 turn log、agent 实际读到的 prompt、model calls。

## 一句话结论

OpenFilm 的剪辑 Agent 不是“调用剪辑 API 的模型”，而是：

> ACP 宿主 + 用户自己的 coding agent + 项目文件夹 + `openfilm` 命令行 + Studio 实时文件监听。

Agent 直接读写项目里的 `film.html`、页面和素材；Studio 监听文件变化并刷新画面。复现的关键是：ACP 会话宿主、项目上下文与指令、领域 CLI、`film.html` 的 revision、实时监听、聊天列与 Studio 引用协议。

## 版本

- OpenFilm Desktop：`0.2.4`
- 对照源码：`openfilm/openfilm` tag `v0.2.4`，commit `53156ac5818d8bad3f2c356043b376b3eebd95ba`
