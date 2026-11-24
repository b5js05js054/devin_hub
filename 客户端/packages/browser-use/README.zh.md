---
description: "浏览器相关的包：内置浏览器工具，以及实验性浏览器后端的注册服务。"
kind: "package-group"
---

# packages/browser-use

[English](README.md) | 中文

## 概述

本组让模型检查与操作网页。内置的 `browser` 工具驱动用户已安装的 Chrome 或 Edge，由默认的 Agent preset 挂载。本组还拥有实验性 提供方 的独占注册；这些 提供方 提供各自的浏览器工具，并管理各 Session 的浏览器资源。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

内置工具不需要 提供方。如果改用实验性 提供方，选择其中一个并挂载共享注册服务。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`browser-use`](browser-use/README.zh.md) | 独占具名 提供方 注册 | `ctx.browserUse` |
| [`tool-browser`](tool-browser/README.zh.md) | 基于随包分发的 agent-browser CLI 的内置 `browser` 工具 | — |

<a id="related-documentation"></a>
## 相关文档

- [浏览器操作](../../docs/subsystems/browser-use.zh.md) — 能力所有权与 提供方 选择。
- [实验包](../experimental/README.zh.md) — Playwright MCP、Chrome DevTools MCP 与 Stagehand 提供方。

<a id="dev-note"></a>
## 开发备注

无。
