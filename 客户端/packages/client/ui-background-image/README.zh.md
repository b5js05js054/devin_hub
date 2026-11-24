---
description: "设置页分区,让用户为应用窗口设置本地背景图片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-background-image

[English](README.md) | 中文

## Summary

在设置中新增"背景图片"分区,用户可以选择一张图片显示在应用后面、移除它,并调整面板盖在图片上的不透明度。图片保存在本浏览器的 IndexedDB 中,不会上传。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

启用该插件即可;`web-app` 已启用。打开设置,选择"背景图片",挑选不超过 30 MB 的图片文件。更大的照片会被重新采样,使长边不超过 2560 像素。滑块决定主面板和侧边栏盖在图片上的不透明度。移除图片后恢复普通主题。

<a id="understand-the-implementation"></a>
## Understand the implementation

插件注册一个 `settings.section` 条目并持有一个控制器。控制器在启动时从 IndexedDB 读取已保存的图片和不透明度,向设置分区发布快照,并把结果应用到 `document.body`:`data-dsh-bg-image` 属性加上 `--dsh-bg-image` 和 `--dsh-bg-panel` 两个自定义属性。插件自带的样式表把图片绘制在页面后方的固定层上,并且仅在该属性存在时,用半透明版本覆盖 `--dsw-alias-bg-base` 和 `--dsw-specific-sidebar-fill`。插件被释放时,属性、自定义属性和样式表都会被移除。

<a id="model-experience"></a>
## Model Experience

无。图片只是浏览器端的呈现,不会进入提示词、消息、Session 日志或工具结果。

#### KV Cache effect

模型请求前缀不变。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 只有主背景和侧边栏会变成半透明。其他面板仍使用不透明的层级底色,所以图片只在这两处透出。
- 图片只保存在一台设备的一个浏览器配置里,不会跟随用户到另一个浏览器或桌面端。
