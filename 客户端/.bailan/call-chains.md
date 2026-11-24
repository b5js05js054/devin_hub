# 调用链

## 欢迎页登录 → 激活 → 工作区
WelcomePage.start() → preload `api.startSignIn` → ipc `dsh-welcome:start` → welcome-window 校验发送方 → `operations.startSignIn`(main.ts)→ `welcomeBackend.relay.start()`(welcome-backend.ts)→ POST `/api/relay/startSignIn` → RelayController.startSignIn → RelayAccount.startSignIn
- RelayAccount.startSignIn:生成 PKCE(verifier/challenge/state)→ callback.ts 起一次性 127.0.0.1 监听 → `account.signIn = {phase:'waiting-browser', authorizeUrl}`(指向网站 `/account/authorize`)
- main.ts 每 1.5s `relay.state()`(GET getState)轮询:推送 `WELCOME_IPC.state` 给欢迎窗;发现 `authorizeUrl` 就 `shell.openExternal`
- 网站:用户注册(QQ 邮箱+头像)/登录 → `/api/user/oauth/authorize` 返回带 code 的回调地址 → 浏览器跳 `http://127.0.0.1:端口/relay/callback?code=&state=`
- RelayAccount 收到回调 → `/api/user/oauth/token`(code+code_verifier)→ 存 token,status='signed-in'
- WelcomePage 看到 `signedIn` → 显示卡密页 → `api.activate` → ipc `dsh-welcome:activate` → `relay.activate` → RelayController.activate → RelayLicense.activate;成功后 main.ts `enterWorkspace()`

## 启动判定
openInitialWindow → readWelcomeState → welcomeBackend.read()(`relay.state()`:signedIn && licensed → `relayReady`)→ `needsWelcome({relayReady})`
- 运行期:轮询发现 ready 由真变假且已进入工作区 → 重新 showWelcome

## 设置页
RelayAccountSection(SignedOut) → `startSignIn`/`cancelSignIn`(ui-relay-account/index.ts `unwrap(ctx.remote.relay.*)`);SignedIn 保留激活/兑换/刷新余额/退出

## 重新登录免输卡密
relay-account `changed`(登录成功)→ RelayLicense.restore()(已有有效授权则跳过)→ POST `/api/license/restore`(账号 + 设备)→ 后端按账号和设备找名下未到期卡密 → 心跳校验 → 返回令牌+卡密 → 存入 license;找不到返回“没有可恢复的卡密”,欢迎页才显示激活页

## 模型列表 → 下拉框
Go 中继 `Catalog`(每 `model_catalog_refresh_seconds` 向后台 `/api/license/models` 拉取)→ `/v1/models`(`openai.go` 输出 context_window/max_output/reasoning_efforts/context_options/`free`/`ratio`)→ llm-relay 拉取并 `displayNameOf`(加“免费/高级 ×倍率”)→ 模型下拉框;客户端按 `modelsPollMs` 静默轮询
- 后台 `client_model` 表 ← `channel_sync.sync_client_models`(保存渠道时删除不在任何渠道的非 `swe-*` 模型)

## 删除会话（永久）
侧栏行菜单 `DeleteSessionMenuItem` → `requestSessionDelete`(写 `deleteRequest` store)→ `SessionDeleteConfirmDialog`(shell.overlay)确认 → `deleteSession` → `UiWorkspace.deleteSession` → `IWorkspaces.deleteSession`(`WorkspaceController`) → `ClientWorkspaceModel.deleteSession` → 远程 `@Remote('deleteSession')` → Host `WorkspaceController.deleteSession`(commands.ts) → `WorkspaceRegistry.deleteSession` → `SessionPersistence.delete`(JSONL 删文件) → `detachSession` + 清理归档/置顶
- 已加载会话:Registry 抛 `WorkspaceLoadedSessionError` → 命令映射 `RemoteError('workspace/session-loaded')` → 客户端 `WorkspaceDeleteSessionError` → 对话框显示 `delete.loaded` 文案
- 成功后:`UiWorkspace` 若当前打开的就是该会话则 `clearMain()`;client model 把 id 从归档集合滤掉

## 系统提示词身份
`cordis.patch.yml`(web-app)关闭固定身份句 → "powered by DevinHub" → 后接 `You are a coding agent powered by the {{model}} model.`

## 五个中继包
relay-account(会话、PKCE)→ relay-license(卡密、设备、余额)→ api-relay-controller(Remote `relay` 命名空间)→ client-ui-relay-account(设置页)→ llm-relay(模型通道,relayURL=http://devinhub.08879.cn/api)
