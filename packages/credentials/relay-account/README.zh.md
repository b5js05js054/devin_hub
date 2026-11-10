---
description: "中继账号服务：注册、登录，并把中继会话令牌保存为凭证授权记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-relay-account

[English](README.md) | 中文

## 概述

对接中继后端（`/api/user/*`）完成注册和登录，并把会话令牌保存在凭证存储中。其他插件通过 `relayAccount.getToken()` 读取令牌；令牌不会离开 Host。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

设置 `apiOrigin` 为后端的 HTTPS 源。源为空时账号处于未配置状态，操作以 `not-configured` 失败；纯 HTTP 在回环主机上需开启 `allowLoopbackHttp`，在任意主机上需开启 `allowHttp`。

`RelayAccount` 提供 `getState`、`getToken`、`startSignIn`（浏览器 PKCE 授权，经一次性回环回调）、`cancelSignIn`、`login`、`register`（可选头像图片）、`refresh`、`logout`，以及背景图操作 `setBackground`、`readBackground` 和 `clearBackground`。状态变化会触发 `relay-account/changed`。返回的 `RelayAccountView` 包含资料和过期时间，不含令牌。失败以 `RelayAccountError` 抛出，错误码由界面本地化：`not-configured`、`network`、`unauthorized`、`rejected`、`invalid-response`、`invalid-image`、`signed-out` 或 `storage`。头像和背景图按内容必须是 png、jpg、gif 或 webp，且不超过 5 MB。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiOrigin` | `''` | 提供 `/api/user/*` 的后端源 |
| `allowLoopbackHttp` | `false` | 允许对回环主机使用 HTTP |
| `allowHttp` | `false` | 允许对任意主机使用 HTTP（无 TLS 的部署） |
| `requestTimeoutMs` | `15,000` | 登录、资料和会话请求的超时 |
| `uploadTimeoutMs` | `300,000` | 注册上传的超时 |

<a id="understand-the-implementation"></a>
## 理解实现

会话保存为 `credentials` 授权记录，同时记录后端源和过期时间。存储的过期时间一过，`getToken` 就不再返回令牌。

<a id="model-experience"></a>
## 模型体验

无，因为会话令牌只用于对中继后端的 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 服务不会在过期前续期会话；会话失效后需要用户重新登录。
- 密码策略由后端强制执行；页面只检查最小长度。
