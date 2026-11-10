---
description: "LLM 路由：通过用户的卡密中继服务器的 OpenAI 兼容接口发送模型请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-relay

[English](README.md) | 中文

## 概述

注册 `relay` 路由。请求发往中继服务器的 `/v1/chat/completions`，以 `relayLicense` 的授权令牌认证；模型列表来自 `/v1/models`，因此客户端既不硬编码也不替换模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

把 `relayURL` 设为中继服务器的源；允许末尾带 `/v1`。需要先激活卡密。

```yaml
- id: llm-relay
  name: '@deepseek-ai/dsh-llm-relay'
  config:
    relayURL: https://relay.example.com
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `relayURL` | 必填 | 中继服务器的源 |
| `displayName` | `Relay` | 模型选择器中显示的名称 |
| `modelsMaxAgeMs` | `600,000` | 列表过期后下次访问时刷新 |
| `modelsTimeoutMs` | `10,000` | 单次列表请求的超时 |

<a id="understand-the-implementation"></a>
## 理解实现

路由封装了 `PiAiAdapter`。授权令牌作为每次请求的密钥提供，模型列表缓存在内存中。

<a id="model-experience"></a>
## 模型体验

### 中继模型请求

#### What the model sees

`relay` 路由上的请求不会由该插件添加模型可见文本；共享的 OpenAI 兼容传输层负责序列化请求，中继服务器负责转发。

#### Token effect

该路由不增加输入 token。中继的 `/v1/models` 列表决定每个模型的上下文窗口和输出上限。

#### KV Cache effect

授权令牌和模型列表不进入模型输入；请求前缀的序列化由传输层负责。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 模型列表缓存在内存中；无网络启动时，在列表加载前不提供任何模型。
- 计费、额度和渠道故障切换由中继服务器决定；该路由只转述其错误。
