---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-25-user-prompt

[English](2026-11-25-user-prompt.md) | 中文

## 概述

为持久消息来源增加 user-prompt。在通用设置保存提示词后，用户从聊天框提交消息时会附上这段文字。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-25-user-prompt
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "ec49e99e2518295f3a2f22e640d16ab9ead67d8b1695945ce54eb3d597c43128"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "221e7c439c95c5a39823c6daa0d017da4c2bef41f2bec65ce137738bd6b4a640"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "df4af063895b01b8813b43586b1254105db2f0b5b46a4a40feb65cfa2a8ead34"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "96eb019c31bf307f87afe2880c360c15cc2c48b8f2764610dae31052b6f72599"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入方使用已有的 user/message 事件、user 角色、文本块和 instructions 形式。当前读取方可以打开旧记录和缺少提示词的配置。旧读取方根据事件的角色与正文重建请求，并按保存的 kind 展示上下文来源。agent/inbox/spliced、developer/message 和 session/title-llm-request 的声明也引用这个来源联合类型。

<a id="verification"></a>
## 验证

user-prompt-settings 浏览器回放在同一会话提交四条消息，覆盖默认关闭、连续两次启用及清空后发送。回放检查了两条用户角色记录、模型请求中的逐字文本与消息身份，并重新打开了会话。四次请求中的系统和开发者消息内容均与首次请求一致。

<a id="dev-note"></a>
## 开发备注

无。
