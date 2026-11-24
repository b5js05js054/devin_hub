---
description: "Relay page uses Remote commands and a snapshot stream over the relay account and license services, without returning any token."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-relay-controller

English | [中文](README.zh.md)

## Summary

The relay page calls this controller for sign-in, registration, card-key activation, top-up, card usage, the published announcement, and a live combined state. Neither the session token nor the license token crosses the Remote.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The `relay` namespace exposes account, license, update, announcement, usage, shop, and watch operations. `announcement()` returns the announcement the operator currently publishes, null when there is none, or the failure code as a value, so a repeating check can tell an unusable session from a transient fault. `usage(days, page, pageSize)` returns totals, per-model spend, and one page of the backend's request records; its optional paging arguments default to page 1 with 20 records. `shopCatalog`, `shopBuyWithBalance`, `shopBuyWithCard`, and `shopOrders` expose the benefit-pack shop: catalog lookup, balance purchase, activation-code redemption, and the order list. Account and license failures use their existing value results. `watch` emits the complete view first and after each observed account or license change.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller forwards to `relayAccount` and `relayLicense` and keeps no state. A combined snapshot rechecks account identity after reading the license; an intervening sign-out or account switch returns the latest account with no license instead of mixing accounts. `pnpm run generate-typert` produces the `/remote` artifacts and `dsh-api-remotes` mounts them.

<a id="model-experience"></a>
## Model Experience

None, as relay account state affects HTTP authentication and never enters model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The stream reports changes the Host observes; a change made by another process appears only after the next refresh.
