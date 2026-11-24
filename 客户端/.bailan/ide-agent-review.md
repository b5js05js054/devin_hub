# IDE / Agent 代码搜索与编写 审查报告

范围:`packages/fs/tool-fs-search`(glob/grep)、`packages/fs/tool-fs`(read/edit/write)、`packages/fs/tool-str-replace-editor`、`packages/lsp/tool-lsp`、`packages/client/ui-editor`(IDE 模式)。
方法:通读上述源码。标注 [已核实] 的结论来自代码本身,标注 [待验证] 的是推断,需要实测。未运行 UI,未做性能测量。

## 一、调用链(审查依据)

- grep: `applyGrepTool -> execute -> parseGrepArgs -> buildGrepCommand -> runRipgrep(resolveRgPath -> ctx.subprocess.spawn -> completeStdout) -> parseGrepMatches(parseRecord) -> toWorkdirRelative`;渲染 `render -> retainGrepMatches -> formatRetainedGrep -> formatGrepOutput`;超限 `tools/post-execute -> trySaveFormattedResult`。
- glob: `applyGlobTool -> execute -> parseGlobArgs -> buildGlobCommand -> runRipgrep`;渲染 `renderGlobPaths -> sampleAcrossTopLevel / formatGlobPage`。
- edit: `applyEditTool.execute -> parseEditArgs -> sandbox.resolvePolicy -> ctx.fs.resolve -> waterfall(fs/edit-intent) -> ctx.fs.editText(fs-local: readForEdit -> applyLiteralEdit -> restoreLineEndings -> writeFileAtomic) -> mutationResult`。
- write: `applyWriteTool.execute -> parseWriteArgs -> ... -> ctx.fs.writeText -> mutationResult`。
- lsp: `apply -> execute -> parseLspArgs -> ctx.lsp.query -> formatLocations / formatHover`。
- IDE: `apply(index.ts) -> ideFace(face.ts: openFile -> load -> readText; follow -> load; write -> load) -> IdePage(Tree / HunkStrip / CodeEditor(sync)) -> hunks.ts(computeHunks / acceptHunk / rejectHunk)`;整轮审查 `TurnActions -> rejectTurn(readText -> revertHunks -> workspaceFiles.write)`。

## 二、Agent 代码搜索

| # | 问题 | 依据 | 建议 |
|---|---|---|---|
| S1 | README 称搜索"包含隐藏和被忽略文件",但 grep 的 argv 只有 `--json --regexp [--glob]`,没有 `--hidden`/`--no-ignore`。grep 会跳过 .gitignore 与隐藏文件,glob 却全包含。两个工具范围不一致 [已核实] | grep.ts `buildGrepCommand` / glob.ts `buildGlobCommand` | 二选一:grep 与 glob 对齐,或修正 README 并在工具描述里写明差异 |
| S2 | glob 只排除 VCS 目录,`node_modules`、`dist`、`target` 等全部返回,`*.ts` 这类查询极易被噪声塞满并触发 spill;`--sort=modified` 还会让 rg 退化为单线程,大仓库变慢 [已核实;单线程为 ripgrep 已知行为,未实测] | glob.ts `GLOB_VCS_EXCLUDES` | 增加可配置的默认排除列表(`globExtraExcludes`);或默认遵守 .gitignore,另给参数显式包含被忽略文件 |
| S3 | grep 能力偏少:没有大小写不敏感、上下文行、仅文件名/计数、多行匹配、文件类型过滤。`include` 只能一个 glob,逗号列表直接拒绝 [已核实] | grep.ts `validateInclude`、`buildGrepCommand` | 增加 `case_insensitive`、`output_mode`(content/files/count)、`context`、`multiline`、`type`;`include` 接受数组 |
| S4 | 大输出处理是"先全量收下再截断":stdout 要在内存里收完(上限 2000 万字节),超过直接 `SEARCH_RAW_OUTPUT_OVERFLOW` 报错,而不是降级为 250 条加 spill。宽泛的 pattern 反而得不到结果 [已核实] | search-core.ts `completeStdout`、grep.ts `execute` | 让 rg 提前停止(如 `--max-count` 加按文件限制),或流式解析到上限后终止进程,并保留 spill |
| S5 | grep 文件间顺序未指定,rg 默认多线程,同一查询两次结果顺序可能不同,不利于缓存命中与对比 [待验证] | grep.ts 无 `--sort` | 可选 `--sort=path`(代价是单线程),或在结果侧按 path 稳定排序 |
| S6 | glob 只返回文件,没有列目录的办法;模型要看目录结构只能用 `str_replace_editor view` 或 shell [已核实] | glob.ts 描述 "files, not directories" | 增加 `type: file/dir` 参数,或提供浅层目录列表工具 |
| S7 | LSP 只有 4 个操作(定义/引用/实现/hover)。缺少 `documentSymbol`、`workspaceSymbol`、`diagnostics`、`rename`、调用层级。坐标要求模型数 UTF-16 列,容易偏一格得到空结果 [已核实] | tool-lsp `LSP_OPERATIONS`、`LSP_PROMPT_TEXT` | 优先加 `diagnostics`(改完立即看报错)与 `documentSymbol`;提供按符号名定位的入口以免数列 |

## 三、Agent 代码编写

| # | 问题 | 依据 | 建议 |
|---|---|---|---|
| W1 | `edit` 成功只返回一句 "updated successfully",没有改动后的片段和行号,模型无法确认落点,常需要再 read 一次 [已核实] | edit.ts `formatEditOutput` | 返回改动区域前后各数行的带行号片段 |
| W2 | `edit` 一次只能改一处。同一文件多处修改需要多次调用,每次都带完整往返,耗 token [已核实] | edit.ts 参数 | 增加 `edits: [{old,new}]` 批量参数,整体原子应用,任一失败全部不写 |
| W3 | 两套编辑工具并存:`edit`/`write` 与 `str_replace_editor`,路径语义不同(后者强制绝对路径,前者按会话 cwd 解析)。且后者的报错 "should start with `/`" 在 Windows 上有误导性(实际接受 `C:\`)[已核实;默认配置里是否同时挂载未核实] | str_replace_editor `resolveTarget` | 同一 profile 只挂一套;或统一路径解析和报错文案 |
| W4 | 改完不触发诊断:没有"编辑后自动给出 LSP 诊断/类型错误"的闭环,模型要靠自己再跑构建 [已核实:代码中无此链路] | edit/write `mutationResult` 之后无诊断步骤 | `mutationResult` 后可选附带该文件诊断摘要(依赖 W4 与 S7 的 diagnostics) |
| W5 | 找不到 `old_string` 时的提示是否给出最接近片段、是否区分空白差异,未核实 [待验证] | `remediateFsError`(error.ts 未读) | 阅读并补充"最相似行"提示,可显著降低重试次数 |
| W6 | CRLF 已由 fs-local 处理(读取归一化、写回还原),这一点没问题 [已核实]。未发现 BOM 处理代码 [待验证] | fsio.ts `normalizeLineEndings`/`restoreLineEndings` | 测试带 BOM 文件的 edit/write 是否保留 BOM |

## 四、IDE 模式:缺陷(按严重度)

### P0 数据丢失或数据错误

- **B1 关闭标签/重命名/删除不提示未保存改动**:`closeFile` 直接 `actions.closed` 删除状态;`closeUnder` 在重命名/移到回收站时同样静默关闭脏标签。草稿直接丢失 [已核实] (IdePage.tsx 标签关闭按钮、face.ts `closeFile`/`closeUnder`)。
- **B2 读取撕裂**:`readText` 分页读取,最终的 `version` 取自最后一页,文本由多页拼接。若 Agent 在翻页之间写文件,会得到新旧混合文本 + 新 version,之后保存能通过版本校验,覆盖掉外部改动 [已核实] (face.ts `readText`)。修复:每页比对 version,不一致则整体重读。
- **B3 加载乱序**:文件监听的每次 `change` 都 `void load(...)`,没有序号;保存后还会再 `load` 一次。两次读取先发后到时,旧内容会覆盖新内容 [已核实] (face.ts `follow`/`write`)。修复:每个文件维护递增请求号,丢弃过期结果。
- **B4 整轮拒绝与提示文案矛盾**:`rejectTurn` 的注释说明"写入中途失败时之前的文件保持已还原",但失败文案是"没有任何文件被改写" [已核实] (turn-review.ts 对比 locales.ts `turnRejectFailed`)。要么失败时回滚已写入的文件,要么改文案。

### P1 功能缺陷

- **B5 Agent 新建文件不出现在文件树**:IDE 只监听已打开的文件,目录没有监听;刷新按钮只重载根目录,已展开的子目录不会更新 [已核实] (face.ts 仅 `follow` 单文件;IdePage 刷新 `loadDir(state.root)`)。`ui-sidebar-files` 已有目录监听(见其 watch 测试),可复用。
- **B6 用户有未保存草稿时,Agent 改动的审查条消失**:`hunks` 仅在 `draft === disk` 时计算,草稿变脏后审查条和全部接受/拒绝按钮一起隐藏 [已核实] (IdePage.tsx `hunks` 的 useMemo)。
- **B7 切换标签会销毁整个 Monaco**:`CodeEditor` 的 effect 依赖 `props.path`,切换文件时 dispose 编辑器和两个 model,撤销历史、光标、滚动、折叠全部丢失 [已核实]。修复:按文件缓存 model,保存/恢复 view state。
- **B8 Agent 改动到来时 `setValue` 整体替换内容**:光标跳动、撤销栈被清空 [已核实] (CodeEditor.tsx `sync`)。修复:按最小编辑 `executeEdits` 应用。
- **B9 普通输入也被渲染成 diff**:始终创建 diff 编辑器,original=baseline,用户自己敲的字会显示成红绿差异 [待验证,按代码推断,请实测]。
- **B10 每次按键触发整套同步**:`hunks` 的 useMemo 依赖 `file.draft`,草稿一变就返回新的 `[]`,于是 `sync` 重建装饰和 view zone,并 `setStrips` 触发重渲染 [已核实]。修复:空结果用稳定常量。
- **B11 没有可见的保存入口**:只有 Monaco 内 Ctrl+S;`save`/`saving` 文案存在但 IdePage 没有使用,`file.saving` 状态也不显示 [已核实]。建议加保存按钮和保存中状态,考虑自动保存选项。
- **B12 JSON 用 JavaScript 语法高亮**:`.json` 被映射到 javascript grammar;未注册 C/C++、C#、PHP、Ruby、Kotlin、Swift、TOML、Dockerfile、PowerShell、Bat 等 [已核实] (monaco.ts)。Monaco 以无 Worker 方式运行,所以也没有 TS/JSON 的语言服务和诊断。
- **B13 目录截断无出路**:`level.truncated` 只显示 "…",没有"加载更多" [已核实]。
- **B14 路径分隔符混用**:`child()` 一律用 `/` 拼接,Windows 根目录是 `C:\x`,得到 `C:\x/a.ts`;`index.ts` 的文件打开回退同样拼 `/`。同一文件可能以不同 key 打开两次 [待验证,需在 Windows 实测]。

### P2 体验与可访问性

- **B15 键盘可达性差**:文件树没有 `role="tree"`、方向键导航、F2/Delete;右键菜单没有键盘触发;分隔条是 `role="separator"` 但不可聚焦、不能用键盘调整;标签是 `role="tab"` 里嵌套 `role="button"`(嵌套交互元素),没有方向键切换、没有中键关闭 [已核实]。
- **B16 缺少 `:focus-visible` 样式**:`.row`、`.tab` 只有 hover/active 样式;拖拽手柄命中区仅 6px 且平时不可见 [已核实] (Ide.module.css)。
- **B17 脏标记语义混淆**:标签上的圆点表示"未保存",文件树里同色圆点表示"Agent 改动待审查",含义不同;有待审查改动的标签上没有标记 [已核实]。建议两种用不同形状/颜色。
- **B18 错误提示通用且不会自动消失**:创建/重命名/删除/复制失败共用 `revealFailed` 一条文案;点击才消失,且只能用鼠标 [已核实]。
- **B19 内联对话框**:新建/重命名/删除确认是文件栏里的内联表单,没有 Esc 取消、没有焦点管理;重命名不会只选中文件名部分(不含扩展名)[已核实]。
- **B20 文案**:`turnRejectFailed` 中文用了半角逗号 `,`;"在资源管理器中显示"/"Reveal in File Explorer"/"移到回收站"为 Windows 措辞,macOS 应为 Finder/废纸篓;`readFailed` 对任何读取失败都说"可能不是文本文件或超限" [已核实]。
- **B21 引用文件给 Agent 只能拖拽**:`mentionFiles` 只在 drop 里使用,右键菜单没有"引用到对话" [已核实]。
- **B22 外观**:Monaco 主题硬编码 `vs`/`vs-dark`、字号 13,不跟应用主题 token;没有字体、字号、自动换行、Tab 宽度设置;截断的文件名没有 `title` 提示;Agent 标签只叫 "Agent 1/2/3",不显示会话标题 [已核实]。
- **B23 布局不持久**:`store.ts` 的 `init` 只有默认值,未见宽度、折叠、打开标签的持久化代码;刷新后全部复位 [已核实:仅就这个包而言,宿主层是否另有持久化未核实]。
- **B24 缺失的 IDE 基础能力**:快速打开(Ctrl+P)、全局搜索、面包屑、分栏、从 Agent 卡片跳转到行号(`openFile` 只有 path/name,没有行号参数;而 read 卡片带 `line`)。

## 五、测试缺口

`packages/client/ui-editor/tests` 只有 `hunks`、`revert`、`store` 三个用例。`face.ts`(B2/B3 的竞态)、`IdePage`(菜单、对话框、标签)、`CodeEditor`、`rejectTurn`(B4)、`agents.ts` 都没有测试。按仓库规则,产品可见的插件还需要真实组合测试。

## 六、建议落地顺序

1. 先修数据安全:B1、B2、B3、B4,每项配回归测试(face.ts 用脚本化 remote 模拟分页中途改文件、乱序返回)。
2. 再补 IDE 日常可用性:B5、B6、B7、B8、B10、B11。
3. 搜索侧:S1(统一语义)、S2(默认排除)、S3(参数补齐)、S4(大输出降级)。
4. 编写侧:W1(带片段的返回)、W2(批量编辑)、S7+W4(diagnostics 闭环)。
5. 最后做 P2:可访问性、文案、主题、持久化、快速打开与全局搜索。

## 七、未核实的部分

`remediateFsError` 的具体提示文案、`TurnActions.tsx`、`agents.ts`、`revert.ts`、`PanelIcon.tsx`、CodeEditor.module.css 没有读;`str_replace_editor` 后半部分(insert/create 等)只读了前 260 行;所有 UI 行为均未在浏览器中实测。
