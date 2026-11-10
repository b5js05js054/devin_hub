---
description: "卡密授权服务：对接中继后端完成激活、心跳、余额和充值。"
kind: "package-reference"
---

# @deepseek-ai/dsh-relay-license

[English](README.md) | 中文

## 概述

为本设备激活卡密，通过心跳保持短期授权令牌有效，并提供余额。`llm-relay` 路由通过 `relayLicense.getCredentials()` 读取令牌。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`RelayLicense` 提供 `getState`、`activate`、`refresh`、`getCredentials`、`refreshBalance`、`redeem`、`usage` 和 `deactivate`，并触发 `relay-license/changed`。它依赖已登录的 `relayAccount`。视图包含掩码卡密、设备名、到期时间和余额，不含令牌。`getCredentials` 在令牌已过期时先续期再返回，令牌距过期不足五分钟时在后台续期。

| 字段 | 含义 |
|---|---|
| `background` | 运行心跳和余额轮询 |
| `heartbeatIntervalMs` | 成功后的心跳周期 |
| `heartbeatRetryMs` | 失败后的心跳周期 |
| `balanceIntervalMs` | 余额轮询周期 |
| `refreshCooldownMs` | 并发刷新调用共享的静默期 |
| `requestTimeoutMs` | 单个后端请求的超时 |

<a id="understand-the-implementation"></a>
## 理解实现

授权状态保存为 `credentials` 授权记录。并发刷新调用共享同一个静默期，因此只触发一次后端请求。

<a id="model-experience"></a>
## 模型体验

无，因为授权令牌只用于对中继的 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 被吊销或过期的卡密要到下一次心跳才会被发现；该窗口内的请求由中继服务器拒绝。
- `usage` 原样返回后端数据，暂无类型化视图。
