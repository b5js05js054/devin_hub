# Agent Note: 客户端独立版本与上游同步范围

Status: implemented

[English](2026-11-20-client-rc6-upstream-sync.md) | 中文

## 问题

客户端跟进上游 DSH 仓库，但保持不同的产品架构与发布历史。同步源码时照抄上游版本，会让客户端发布序列受另一个仓库支配；整批移植也会模糊本次实际选择了哪些行为。

## 决策

客户端拥有独立递增的 dsh 版本序列（[发布政策](2026-08-10-npm-release-sequences.zh.md)）。上游 tag 只标识源码基线，不决定也不替换客户端版本。每次上游同步都记录客户端版本以及精确的纳入范围和排除范围。客户端 `0.2.2-rc.6` 的上游来源是 `dsh-v0.2.2-rc.5`，`0.2.2-rc.7` 的上游来源是 `dsh-v0.2.3-alpha.1`。

### 纳入 0.2.2-rc.6

| 领域 | 范围 |
|---|---|
| Markdown 文件目标 | 让两个 Markdown parser 都保留 Windows 分隔符；解析行号、范围和列号后缀，同时保留 URL scheme 与 UNC 限制。在 `packages/client/ui-primitives/tests/markdown-file-links.client.spec.tsx` 保留聚焦回归测试；同步更新中英 package README 与配对记录，说明接受的后缀和限制。 |
| 宽 Markdown 表格 | 保留 `packages/client/ui-primitives/src/markdown/MarkdownText.module.css` 中针对 hover-capable 输入的滚动条规则，以及 `apps/web/tests/markdown-wide-table.e2e.ts` 中仅触屏场景的横向滚动检查。 |
| Desktop 认证清理 | 按来源限制的旧 Host cookie 清理实现已与上游一致。仅在 `apps/desktop/tests/main-startup.spec.ts` 增加通过 Electron 默认 session 删除 cookie，以及清理失败不阻断启动的覆盖。 |
| 原生目录选择器 | 选择器实现已与上游一致。仅在 `packages/host/directory-picker-native/tests/native-picker.spec.ts` 增加生成的 JXA 测试，覆盖选中、取消和空选择。 |
| 发布 manifest | 将 `release:dsh` 选择的 workspace 根及 357 份 app/package manifest 设为 `0.2.2-rc.6`（共 358 个目标）。在 `packages/client/ui-primitives/package.json` 与其 lockfile importer 声明现有的 `micromark-util-decode-string` 依赖。 |

`packages/client/ui-primitives/src/useModalLayer.ts` 已与上游一致；保留焦点恢复行为，不重复移植源码。中英文 package README 记录支持的路径后缀、URL 限制与 UNC 拒绝行为。

### 0.2.2-rc.6 排除范围

| 上游改动或领域 | 决定 |
|---|---|
| Agent Team 与任务看板架构 | 不以上游 subagent-owned task board 替换客户端实验性的 roster、mailbox、tools、UI 或 persistence 模型。 |
| 插件管理与终端 UI | 不替换动态插件 runner 或核心 terminal。上游 Plugin Manager 增补与 Agent-terminal sidebar 属于独立功能。 |
| Node 引擎下限 | 保留 `^22.19.0 || >=24.0.0`。上游 `>=24.9.0` 会排除仍在客户端支持范围内的 Node 22 与 Node 24.0-24.8。 |
| 其他 Markdown 呈现变更 | 暂缓可选的 `omitHtml`、TeX-aware copy 与 CJK autolink；它们不是所选路径修复的必要条件，且涉及独立的渲染或依赖问题。 |

### 0.2.2-rc.7 同步范围

- 空白聊天输入框支持用上下方向键浏览当前会话已发送的文本，保留正在编辑的草稿、附件和输入法操作。
- 浏览器拒绝异步剪贴板写入时，复制控件尝试兼容命令并恢复键盘焦点。桌面启动 VS Code、Cursor 等外部应用时清除继承的 Electron Node 模式标志。
- `read` 和 `glob` 只保留选中的行或路径，让大型源文件和搜索输出可被回收。
- DeepSeek 图片上传在发送前编码完整的 multipart 请求体，上传开始时取消仍可继续使用同一运行时。
- 单文件发行版本用绝对路径启动 JSONL 迁移校验 Worker，支持重新打开旧会话。

此版本沿用本地 IDE、账号卡密、模型中继、专家编排、桌面更新渠道及现有 Node 支持范围。上游的会话面板、代码审阅、连接器、SQLite 会话存储和默认 PTC 模式调整留待独立集成。

## 曾考虑的替代方案

**照抄上游发布版本。** 不采用：同步源码不转移客户端已发布序列的所有权；显式客户端版本让客户端产物拥有唯一且可审查的发布版本。

**一批移植所有上游功能。** 不采用：team、plugin 与 terminal 的实现，其所有权和持久化模型存在实质差异。一起引入会把本次同步扩大为无关的产品工作。

**提高客户端 Node 下限以匹配上游。** 不采用：Node `^22.19.0` 及 Node `24.0` 至 `24.8` 仍在声明的客户端支持范围内，也没有决定停止支持它们。

## 后果

`0.2.2-rc.6` 覆盖 `release:dsh` 共享版本计划中的 358 份 manifest：workspace 根及 357 份 app/package manifest。计划也包含 package name 不符合 `@deepseek-ai/dsh-*` 命名模式的私有 workspace。此版本不更新客户端 Node 引擎范围，也不表示被暂缓的上游功能永远不支持。未来每份同步记录都写明自己的上游基线与所选范围；发布序列始终由客户端拥有。
