---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-25-user-prompt

English | [中文](2026-11-25-user-prompt.zh.md)

## Summary

Adds the user-prompt producer to the sources that can accompany a stored message. Saving a prompt in General lets the owner attach their text to subsequent chat submissions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The writer uses the existing user/message event, user role, text block and instructions form. Current readers accept earlier records and configurations that omit the preference. Earlier readers replay role and content from the event and render a nonhuman context producer using its stored kind. The extended source union is also referenced by agent/inbox/spliced, developer/message and session/title-llm-request.

<a id="verification"></a>
## Verification

The user-prompt-settings browser replay recorded four human submissions with the preference off, enabled for two messages, then cleared. It checked two separate user-role records, their exact text and identities in the model requests, and reloaded the same conversation. The system and developer content matched the initial request throughout.

<a id="dev-note"></a>
## Dev Note

None.
