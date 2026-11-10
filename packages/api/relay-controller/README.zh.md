---
description: "中继页面通过 Remote 操作和快照流使用中继账号与授权服务，不返回任何令牌。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-relay-controller

[English](README.md) | 中文

## 概述

中继页面通过该控制器完成登录、注册、卡密激活、充值、用量查询，并获得实时的合并状态。会话令牌和授权令牌都不会经过 Remote。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`relay` 命名空间提供账号、授权、更新、用量和观察操作。`usage(days, page, pageSize)` 返回汇总、按模型花费和后端请求明细中的一页；可选分页参数默认为第 1 页、每页 20 条。账号和授权失败沿用原有的值返回形式。`watch` 先发送完整视图，并在每次观察到账号或授权变化后再次发送。

<a id="understand-the-implementation"></a>
## 理解实现

控制器向 `relayAccount` 和 `relayLicense` 转发，自身不保存状态。`/remote` 产物由 `pnpm run generate-typert` 生成，并由 `dsh-api-remotes` 挂载。

<a id="model-experience"></a>
## 模型体验

无，因为中继账号状态只影响 HTTP 认证，不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 流只报告 Host 观察到的变化；其他进程所做的更改要到下一次刷新才会出现。
