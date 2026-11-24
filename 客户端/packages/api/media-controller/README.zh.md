---
description: "媒体参数面板通过 Remote 操作从中继读取图片或视频模型的可调参数，并按会话记住用户选择的取值。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-media-controller

[English](README.md) | 中文

## 概述

媒体参数面板通过该控制器了解图片或视频模型接受哪些参数，并保存用户选择的取值。授权令牌不会经过 Remote。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

用 `relayURL` 配置中继源，末尾的 `/v1` 也可接受。`media` 命名空间提供 `getSpec` 和 `setParams`。`getSpec(model)` 返回 `{ ok: true, spec }`，其中有媒体类型、字段是否经上游确认或为内置默认值，以及字段列表。失败以值的形式返回：对话模型为 `not-media`，没有卡密为 `not-activated`，网络或中继错误为 `unavailable`。`setParams(sessionId, model, params)` 保存该会话和模型的取值，传入空对象则清除。

<a id="understand-the-implementation"></a>
## 理解实现

`getSpec` 用 `relayLicense.getCredentials()` 的令牌请求中继的 `/v1/media/spec`。所选取值保存在服务实例中，通过仅限 Host 的 `paramsOf(sessionId, model)` 读取，`llm-relay` 把它作为 `X-Relay-Media-Params` 头发送。Host 进程只在内存中保存这些值。`/remote` 产物由 `pnpm run generate-typert` 生成，并由 `dsh-api-remotes` 挂载。

<a id="model-experience"></a>
## 模型体验

无，因为取值只通过 HTTP 头到达中继，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Host 重启后所选取值会丢失，中继在每次请求时会重新校验这些值。
