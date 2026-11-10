---
description: "设置页面：注册、登录并管理中继卡密授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-relay-account

[English](README.md) | 中文

## 概述

在设置中新增“中继账号”页。未登录时提供登录和注册（邮箱、密码、可选头像）；登录后显示授权和余额，并支持卡密激活和充值兑换。用量页展示汇总、按模型花费和可分页的模型请求明细，包括 Token、缓存、费用、免费及估算标记。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

与 `relay-account`、`relay-license` 和 `relay-controller` 一起启用；`web-app` 已启用这四个包。页面跟随 Remote 的 `relay.watch` 流。被拒绝时显示后端消息；网络、过期和图片错误显示本地化文案。调用 Host 前，页面先检查邮箱格式、至少 6 位密码以及确认密码。

<a id="understand-the-implementation"></a>
## 理解实现

组件只接收普通属性和回调，看不到 `ctx`。插件持有流订阅，并向组件发布唯一的快照。

<a id="model-experience"></a>
## 模型体验

无，因为该页面只是浏览器端展示，不贡献提示、消息、模式或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 头像会读入内存并以 base64 发送；大小上限由 Host 执行。
- 页面没有找回密码流程，因为后端未提供。
