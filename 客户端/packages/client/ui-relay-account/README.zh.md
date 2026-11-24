---
description: "设置页面：注册、登录并管理中继卡密授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-relay-account

[English](README.md) | 中文

## 概述

在设置中新增“中继账号”页。未登录时提供登录和注册（邮箱、密码、可选头像）；登录后效益包（免费模型权益）与余额（高级模型钱包）分卡展示，支持激活码激活与充值兑换，并内嵌商城：用余额或激活码购买效益包。账号菜单和用量设置提供网页用户中心入口，可查看个人用量、模型价格和自愿参加的用户排行。账号登录期间，插件还会把运营方发布的公告显示为窗口顶部的横幅。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

与 `relay-account`、`relay-license` 和 `relay-controller` 一起启用；`web-app` 已启用这四个包。页面跟随 Remote 的 `relay.watch` 流。被拒绝时显示后端消息；网络、过期和图片错误显示本地化文案。调用 Host 前，页面先检查邮箱格式、至少 6 位密码以及确认密码。

公告横幅无需配置。它显示运营方在后台发布的标题、内容和级别，启用后约 5 秒内出现，随修改更新，运营方撤下后消失。关闭横幅后，该公告在本设备上不再显示，直到标题、内容或级别有改动，或者撤下后重新发布。

<a id="understand-the-implementation"></a>
## 理解实现

组件只接收普通属性和回调，看不到 `ctx`。插件持有流订阅，并向组件发布唯一的快照。切换账号时会丢弃卡密草稿和商城结果。登录后的账号视图提供用户中心链接，浏览器使用网站的登录会话读取用量。

公告观察器在出现已登录的会话时立即调用 Remote 的 `relay.announcement`，并在每次返回后 5 秒再次调用，因此检查不会重叠。页面隐藏时暂停，重新显示时立即检查。检查失败时横幅保持原样；返回 `signed-out` 或 `unauthorized` 时隐藏横幅并停止检查，直到出现另一个会话。横幅注册到 `shell.overlay`，已关闭的公告记在浏览器的 `localStorage` 中。

<a id="model-experience"></a>
## 模型体验

无，因为该页面只是浏览器端展示，不贡献提示、消息、模式或工具结果。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 头像会读入内存并以 base64 发送；大小上限由 Host 执行。
- 页面没有找回密码流程，因为后端未提供。
- 后端只向已登录的账号返回公告，因此未登录的客户端不显示公告。
- 每个已登录且页面可见的客户端每 5 秒请求一次后端；间隔固定在客户端内，后端无法调整。
- 已关闭的公告按设备记忆，而不是按账号。
