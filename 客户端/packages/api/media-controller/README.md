---
description: "The media parameter panel uses Remote commands to read an image or video model's adjustable parameters from the relay and to remember the values chosen per session."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-media-controller

English | [中文](README.zh.md)

## Summary

The media parameter panel calls this controller to learn which parameters an image or video model accepts and to store the values the user chose. The license token never crosses the Remote.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Configure `relayURL` with the relay origin; a trailing `/v1` is accepted. The `media` namespace exposes `getSpec` and `setParams`. `getSpec(model)` returns `{ ok: true, spec }` with the media kind, whether the fields were confirmed by the upstream or are built-in defaults, and the fields. Failures are values: `not-media` for a chat model, `not-activated` without a card key, and `unavailable` for network or relay errors. `setParams(sessionId, model, params)` stores the chosen values for that session and model, and an empty object clears them.

<a id="understand-the-implementation"></a>
## Understand the implementation

`getSpec` requests the relay `/v1/media/spec` with the token from `relayLicense.getCredentials()`. The chosen values live in the service instance and are read through the Host-only `paramsOf(sessionId, model)`, which `llm-relay` sends as the `X-Relay-Media-Params` header. The Host process keeps them only in memory. `pnpm run generate-typert` produces the `/remote` artifacts and `dsh-api-remotes` mounts them.

<a id="model-experience"></a>
## Model Experience

None, as the values reach the relay only in an HTTP header and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The chosen values are lost when the Host restarts, and the relay validates them again on every request.
