# 任务清单

## 已完成(代码已写,未部署/未跑测试)
- 后端 card-auth-system:`/api/user/oauth/authorize`、`/api/user/oauth/token`(PKCE、loopback、一次性、5 分钟)
- 网站前端:`/account` 页(登录/注册/授权)
- relay-account:`startSignIn`/`cancelSignIn`、`allowHttp`
- relay-controller:暴露 `startSignIn`/`cancelSignIn`
- 设置页:账号密码表单 → 浏览器登录按钮
- 桌面欢迎页:登录(浏览器)→ 卡密激活页;删 API Key/稍后配置/官方 OAuth
- 启动判定 `needsWelcome({relayReady})`:中继已登录且卡密有效才跳过欢迎页
- `cordis.patch.yml`:relay-account 配 `apiOrigin: http://devinhub.08879.cn` + `allowHttp: true`

## 待办
- 用户自己部署:重启 8002、重新构建网站前端 dist
- `pnpm build:artifacts` 重新生成各包 `.d.ts`(Node ≥ 22.19)
- relay-account `tests/account.spec.ts` 补 PKCE/startSignIn 用例;relay-controller `controller.spec.ts` 补 startSignIn
- 桌面端 `tests/welcome-*.spec.ts`、`welcome-renderer.client.spec.tsx`、`welcome-flow.e2e.ts` 仍按旧 API Key/官方 OAuth 写,需改
- llm-relay 的 `/api/v1/models`、`/chat/completions` 在 card-auth-system 中未找到,由 server-go(relay_server.exe)提供,线上 8002 需换成它或让 nginx 分流
- `apps/desktop/src/account-backend.ts` 现在无引用,确认后可删

## 2026-10-21 追加
- 客户端模型目录残留：`channel_sync.sync_client_models` 的 `gone` 改为「不在任何渠道里的非 `swe-*` 模型」，保存渠道即清理；`Models.vue` 说明同步更新
- 中继目录刷新：后台已返回 14 个，`/api/v1/models` 也已是 14 个（重启/等待目录刷新后生效）
- 首屏品牌：`ui-conversation` 的 `hero.headline` 中英均改为 `DevinHub`；`EmptyHero` 标题加 `data-testid="hero-headline"`；同步更新 `apps/web/tests/*.e2e.ts`、`snapshots/web/**`、`skeleton.client.spec.tsx`
- 未处理：首屏鲸鱼 `HeroFish` 仍是 DeepSeek 的官方标志，待用户提供自有 logo 再换
- 重新登录免输卡密：后端新增 `POST /api/license/restore`（`routers/license.py`、`schemas.py`），客户端 `RelayLicense.restore()` 在 `relay-account/changed` 后自动调用；2 个测试已过。旧后端无此接口时客户端静默跳过。**需用户部署后端并重启 8002**
- 系统提示词身份：`packages/bundle/web-app/cordis.patch.yml` 关闭固定的 "powered by DeepSeek Harness"，改为 "powered by DevinHub"；`snapshots/web/**/system-prompt.expected.md`(11 个)与 `replay-round-trip.e2e.ts` 已同步；`snapshots/session/` 约 80 个快照用其他 profile，未动
- 模型思考强度/上下文：`/v1/models` 输出 `reasoning_efforts`/`context_options`，`llm-relay` 读取并映射到 pi-ai 模型字段
- 模型免费/倍率：Go `internal/relay/openai.go` 从 `Catalog.Ratio()` 输出 `free`/`ratio`；`llm-relay` 的 `displayNameOf` 加“免费/高级 ×倍率”徽标；Go 测试与 `relay.spec.ts`(4/4) 已过。下拉框实际显示未目测
- 删除会话（永久删除）：JSONL `delete` → `WorkspaceRegistry.deleteSession` → `workspace-controller`（`@Remote('deleteSession')`、`workspace/session-loaded`、`WorkspaceDeleteSessionError`）→ `IWorkspaces.deleteSession` → `UiWorkspace.deleteSession` → 侧栏菜单“删除会话”(order 500)+确认框 `workspace.session-delete`。已加载会话拒绝并提示重启应用
  - 已跑：JSONL 删除用例、注册表 3 个删除用例、`workspace`/`workspace-controller` 两端/`ui-workspace` 类型检查；已执行 `scripts/generate-typert.ts`
  - 已同步：`client-runtime` 的 fake `IWorkspaces`、`workspaces-service`/`apply` 两个测试桩、两个包 README(中英)
  - 未写：删除菜单项/确认框的组件测试、控制器 Host 测试、`transport.client.spec.ts`/`runtime.client.spec.tsx` 的删除用例；未跑 ui-workspace 现有测试
  - **卡点**：`pnpm run gen-cordis-api` 报 14 处类型链接违规（`WorkspaceDeleteSessionRequest/Value`、`SessionPersistenceDeleteOptions`，以及 `RelayAccountView`、`RelayImageInput`、`RelayBackground`、`RelayLicenseView`、`RelayLicenseOutcome`、`LicenseCredentials`）。需登记到 `linkedTypePages`/`typeLinkExemptions` 后重新生成，再同步 `tool-cordis/src/api-catalog.ts`、`cordis-client-runner/src/client/api-catalog.ts` 与其 spec 的期望签名
  - 其他 `SessionPersistence` 实现（内存等）只搜了子类文件，默认基类实现为抛“不支持删除”，未逐个确认
- 补了 `relay-account`(`getState`/`getOrigin`/`readBackground`)与 `relay-license`(`getState`) 缺失的 JSDoc 描述（cordis 目录生成要求）
- 后台登录入口隐藏：前端路由 `/login` 改为 `/hq-7k3x9q`；未登录访问后台页面、接口 401 都跳用户页 `/account`；未知路径兜底重定向 `/account`；改密后跳新路径。后端 `/api/auth/login` 未动、未加限流/IP 限制（用户选择只改路径）。需重新 build `frontend/dist` 部署。vue-tsc 通过

## 2026-10-22 追加
- 正式包模型列表为空:根因是 `llm-relay` 从 `@deepseek-ai/dsh-llm-pi-ai/src/config.ts` 导入 `resolveProfiles`,而发布包只带 `lib/`,插件 import 失败(ERR_MODULE_NOT_FOUND)。已改为 `llm-pi-ai` 的 `index.ts` 导出 `resolveProfiles`,`llm-relay` 走公开入口。已跑 `build:lib:host` 通过;需用户重新打包验证。

## 模型图片识别开关
- 后台 client_model.supports_image -> /api/license/models 下发 -> server-go catalog.options.image -> /v1/models 的 input_modalities -> llm-relay 映射为 pi-ai input。
- 后台批量接口 POST /api/models/batch-image {ids, supports_image}，Models.vue 勾选后批量开启/关闭。
- 未开启的模型 input_modalities 仅 text，客户端会提示不支持图片。

## 图片输入修复（llm-relay 附件服务）
- 现象：图片通过能力校验后仍报 `pi-ai image input requires the durable attachment service` (UNSUPPORTED_CONTENT)。
- 原因：llm-relay 构造 PiAiAdapter 时没传 resolveAttachments / resolveImageAccess，adapter.ts:398 直接抛错。
- 修复：packages/llm/llm-relay/src/index.ts 补 resolveAttachments: () => ctx.get("attachments") 与 resolveImageAccess（走 resolveImageAttachmentAccess + ctx.get("fs").processPathFromHostPath），tsconfig/package.json 补 dsh-attachment、dsh-fs 依赖。

## 品牌图标替换（鲸鱼 -> 云朵图标）
- 源图：根目录「解释更新商品的含义.png」，裁成圆角方块（去白边与右下水印）。
- 已替换：apps/desktop/resources/{icon,icon-macos,icon-windows}.png/.svg、tray-windows.ico；apps/web/public/favicon*.svg、website/public/favicon.svg。
- 界面：packages/client/ui-primitives/src/FishLogo.tsx 改为内嵌 128px PNG（侧栏/欢迎页品牌标记走它）。
- 未改：BrandWordmark.tsx 里的 deepseek 文字字标与徽章（OfficialBrandName 使用），以及 EmptyHero 的 HeroFish 动画兜底。

## IDE 面板（ui-editor）
- 已完成：workspace-files `write`；三栏 IDE；底部终端（`terminal.embedded` Factory，实现放在 terminal.tsx 内，因为包内动态 chunk 不能互相 require）；READMEs；store/hunks/terminal-controller/sidebar-terminal 测试。
- 已浏览器实测：文件树、底部终端出现 xterm。
- 已知与本改动无关：workspace-files 5 个 symlink 用例在 Windows EPERM 失败；relay-account 的 i18n/Model Experience 校验失败（未跟踪目录，非本次改动）；页面 `remote.session without inject` 来自 ui-model-selection。
- 未做：Agent 编辑后 diff 审阅的真实 Agent 流程未在浏览器实测。
- 修复：Agent 列用固定 phase=active（输入框钉在底部、对话区滚动）；agentBody 改 flex 列。
- 修复：点开文件后整页样式丢失——根因是 Monaco 的 editor.main 在包内产生 chunk 间同步 require，运行时模块表缺失，加载失败触发 removeOwnedStyles 清掉本包全部样式。现 src/client/monaco.ts 用 edcore.main + 13 种 basic-languages 打成单个自包含 chunk（新增语言在此登记）。
- 修复：.center 不再 composes column（产物里 display:flex 丢失导致编辑器高度 5px）。
- 修复：diff 审阅不再在顶部工具条里逐块铺按钮。hunks.ts 增加 mergeContext（相隔 <=6 行未变代码的改动并为一个块）；CodeEditor 用 Monaco view zone + createPortal 把「接受/拒绝」贴在每个块上方，并把 .view-zones 提到代码层之上（z-index 5 + pointer-events none，strip 设回 auto），否则按钮被 .view-lines 吞掉点击。顶部只留「全部接受/全部拒绝」+ 块数。
- 验证：探针文件 E:\devinhub官网\__ide-hunk-probe.py 造 2 块 diff -> blocks=2（L3/L15），点第一块接受后 -> 1 块；接受不改磁盘。探针已删除。
