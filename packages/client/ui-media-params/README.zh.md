---
description: "位于模型选择旁的输入框面板,为所选图片或视频模型提供生成参数。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-media-params

[English](README.md) | 中文

## 概述

在输入框的模型选择旁新增一个设置按钮。只有选中图片或视频模型时才出现,用户可以在发送前设置尺寸、质量、时长、分辨率和画面比例等选项。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

与 `media-controller` 和 `llm-relay` 一起启用;`web-app` 已启用这三者。选择图片或视频模型后打开按钮即可修改选项,用户修改前使用默认值。中继无法向上游确认选项时,面板会提示。对话模型不显示按钮,查询失败时显示重试操作。

<a id="understand-the-implementation"></a>
## 理解实现

插件注册 `conversation.input.media` 条目,从会话的模型目录读取所选模型,向 `media-controller` 请求规格,并通过 `setParams` 按会话和模型保存每次选择。`llm-relay` 把保存的取值作为请求头发送。组件只接收普通属性和回调,从不接触 `ctx`。

<a id="model-experience"></a>
## 模型体验

无,因为取值通过 HTTP 头发给中继,不进入提示、消息、Session 日志或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 面板每次切换模型都向中继请求规格来判断是否为图片或视频模型,中继响应慢时按钮会延迟出现。
- Host 重启后不会恢复已选取值,面板会为所选模型重新加载默认值。
