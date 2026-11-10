---
description: "Settings page to register, sign in, and manage the relay card-key license."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-relay-account

English | [中文](README.zh.md)

## Summary

Adds a Relay account section to Settings. Signed out, it offers sign-in and registration (email, password, optional avatar). Signed in, it shows the license and balance and supports card-key activation and top-up redemption. The usage view shows totals, per-model spend, and paginated model-request records with token, cache, cost, free, and estimated details.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Enable the plugin together with `relay-account`, `relay-license`, and `relay-controller`; `web-app` enables all four. The section follows the Remote `relay.watch` stream. Rejections show the backend message; network, expiry, and image failures show localized copy. Before calling the Host, the page checks the email form, a minimum password length of 6, and the confirmation.

<a id="understand-the-implementation"></a>
## Understand the implementation

The component takes plain props and callbacks and never sees `ctx`. The plugin owns the stream subscription and publishes one snapshot to the component.

<a id="model-experience"></a>
## Model Experience

None, as the page is browser presentation and contributes no prompt, message, schema, or tool result.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The avatar is read into memory and sent as base64; the Host enforces the size limit.
- The page has no password-reset flow because the backend exposes none.
