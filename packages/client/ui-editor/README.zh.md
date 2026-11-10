---
description: "Web 侧栏的 IDE 面板：文件树、可接受或拒绝 Agent 修改的 Monaco 代码编辑器、Agent 对话与底部终端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-editor

[English](README.md) | 中文

## 概述

在 Web 侧栏打开 **IDE**，即可浏览当前 Session 的工作区、编辑文本文件，并在代码旁观察 Agent 工作。可按文件名或文本搜索整个工作区，并跳到匹配的行。Agent 修改已打开的文件时，可以逐处审阅并接受或拒绝，也可以整文件一次处理。三列可拖拽或折叠，编辑器下方可打开终端。只有磁盘版本未变化时文件才会保存。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在侧栏选择 **IDE**。页面绑定到所选 Session 的工作区，分为三列：文件树、编辑器与 Agent 对话。没有工作区的 Session 显示空状态提示。

### 打开、编辑与保存

点击文件在标签页中打开，点击文件夹展开，刷新按钮会重新读取文件树。在编辑器中修改后按保存快捷键写回文件。标签页的文本与磁盘不同时显示圆点。不是 UTF-8 文本、或大于 workspace-files 大小上限的文件会显示读取失败，而不会打开。

如果文件在你读取之后又在磁盘上变化，保存会被拒绝，页面显示冲突提示；不会覆盖任何内容。

### 搜索与快速打开

按 `Ctrl/Cmd+P` 按文件名打开文件，按 `Ctrl/Cmd+Shift+F` 搜索文件内容；文件列中的搜索按钮打开同一个面板，可在 **文件** 与 **内容** 之间切换。结果来自 Host 的 `search`，因此也覆盖你没有展开的文件夹。查询是纯文本，不是正则表达式。用方向键加 `Enter` 或点击打开结果；内容结果会在匹配的行和列打开文件。搜索会跳过 `.git`、`node_modules`、`dist` 等版本控制与构建目录；因达到上限或有内容无法读取而只返回部分结果时，界面会给出提示，空结果也并不覆盖被跳过的目录。

### 键盘操作

在文件树中，方向键移动并折叠或展开文件夹，`Enter` 打开，`F2` 重命名，`Delete` 把选中项移到回收站。标签页可用关闭按钮或鼠标中键关闭，列分隔条可用方向键调整。关闭、重命名或删除含未保存编辑的文件前，会先请你确认是否放弃这些编辑。

### 审阅 Agent 的修改

Agent 修改已打开的文件且你在其中没有未保存的编辑时，编辑器会高亮新增与删除的行，并显示审阅栏。可以用 **全部接受** 或 **全部拒绝** 处理整个文件，也可以用直接贴在某个变更块上方的 **接受** 与 **拒绝** 条；相隔不超过六行未变代码的改动合并为一个块。接受会把当前磁盘文本设为新的基线。拒绝会把该块改动之前的文本写回。

### 布局与对话

拖拽分隔条可调整文件列与 Agent 列的宽度，任一列都可折叠成窄条。Agent 列内嵌该 Session 的对话，因此不离开编辑器就能发送指令、阅读 Agent 的回复。

### 终端

展开编辑器下方的 **终端** 栏，可在 Session 工作区中打开终端。拖拽其上方的分隔条可调整高度。折叠该栏会隐藏终端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

### 注册

插件注册一个根作用域的 `main` 面板（带侧栏入口），以及一个 Session 作用域的子 slot `ide.workspace`，页面就放在其中。Session 作用域通过声明的 store 让每个 Session 拥有自己的标签页、草稿与布局，因此切换 Session 不会泄漏标签页。

### 状态与 I/O

页面只通过 store 的 actions 和注入的 face 读写。face 调用 `workspaceFiles` Remote：`list` 读取文件树，`read` 读取文件文本，`write` 携带上次读取的版本保存，`changes` 得知 Agent 修改了文件。每次磁盘观察都会更新 store 的 `disk` 文本与版本；`baseline` 文本是用户上次接受的文本。

### 审阅

`hunks.ts` 是基线与磁盘文本之间的纯行级 diff；相隔不超过六行未变代码的改动会合并为一个可审阅的块。接受一个块会把它的磁盘行复制进基线；拒绝一个块会把它的基线行写回磁盘。diff 在主线程运行，因此不需要 Monaco worker。

### 编辑器

Monaco 在首次打开时懒加载，并且不使用 worker。构建通过共享的 client 打包器把它的样式表与图标字体内联进 client bundle。

### 终端

底部面板渲染侧栏终端包提供的 `terminal.embedded` factory，它在挂载期间保持终端连接。

| 文件 | 内容 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | slot 与面板注册 |
| [`src/client/IdePage.tsx`](src/client/IdePage.tsx) | 列、文件树、标签页、搜索面板、审阅栏、对话与终端位 |
| [`src/client/store.ts`](src/client/store.ts) | 按 Session 的 store：标签页、文件文本、布局 |
| [`src/client/face.ts`](src/client/face.ts) | Remote 调用、搜索与文件变化处理 |
| [`src/client/hunks.ts`](src/client/hunks.ts) | 行级 diff、接受与拒绝 |
| [`src/client/CodeEditor.tsx`](src/client/CodeEditor.tsx) | Monaco 封装、改动高亮、分块审阅条与搜索结果定位 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些页面覆盖本面板使用的服务与 slot。

- [workspace-files](../../api/workspace-files/README.zh.md)——读取、写入并监听文件的 Remote。
- [ui-sidebar-terminal](../ui-sidebar-terminal/README.zh.md)——底部面板内嵌的终端。
- [ui-sidebar](../ui-sidebar/README.zh.md)——IDE 入口注册进的面板列表；[ui-layout](../ui-layout/README.zh.md)——页面占用的主 slot。
- [ui-conversation](../ui-conversation/README.zh.md)——Agent 列内嵌的对话。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的编辑界面，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延期工作

- 只支持文本文件；图片和其他二进制文件无法打开。
- 编辑 Agent 正在修改的文件可能以冲突提示告终，因为磁盘版本移动后保存会被拒绝。
- Monaco 不使用语言 worker，因此只提供高亮，没有类型检查或补全。

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了编辑器的范围；它们是当前包的约束。

- **文件操作有限**——文件树可以新建、重命名并把文件移到回收站，但不能复制或在文件夹之间移动，也不显示 Git 状态标记；只能保存已有的文本文件。
- **每个文件一个基线**——审阅比较的是上次接受的文本与磁盘文本；没有逐次编辑历史，也无法撤销已接受的改动。
- **审阅需要干净草稿**——文件有未保存的编辑时，页面不会为其显示 Agent 审阅。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
