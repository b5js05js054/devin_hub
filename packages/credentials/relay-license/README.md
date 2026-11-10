---
description: "Card-key license service: activate, heartbeat, balance, and top-up against the relay backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-relay-license

English | [中文](README.zh.md)

## Summary

Activate a card key for this device, keep the short-lived license token fresh with a heartbeat, and expose the balance. After the account signs in again, `restore()` asks the backend (`POST /api/license/restore`) for an unexpired card already bound to this account and device, so the card key is not requested twice. The `llm-relay` route reads the token through `relayLicense.getCredentials()`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`RelayLicense` exposes `getState`, `activate`, `refresh`, `getCredentials`, `refreshBalance`, `redeem`, `usage`, and `deactivate`, and emits `relay-license/changed`. It needs a signed-in `relayAccount`. Views carry a masked card key, device name, expiry, and balance, never the token. `getCredentials` renews an expired token before returning and renews in the background when the token is within five minutes of expiry.

| Field | Meaning |
|---|---|
| `background` | Run the heartbeat and balance polling |
| `heartbeatIntervalMs` | Heartbeat period after a success |
| `heartbeatRetryMs` | Heartbeat period after a failure |
| `balanceIntervalMs` | Balance polling period |
| `refreshCooldownMs` | Quiet period shared by concurrent refresh callers |
| `requestTimeoutMs` | Deadline per backend request |

<a id="understand-the-implementation"></a>
## Understand the implementation

The license state is a `credentials` grant record. Concurrent refresh callers share one quiet period, so they cause a single backend call.

<a id="model-experience"></a>
## Model Experience

None, as the license token authenticates HTTP calls to the relay and never enters model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A revoked or expired card is detected at the next heartbeat; the relay server rejects requests in that window.
- `usage` returns the backend payload unchanged and has no typed view yet.
