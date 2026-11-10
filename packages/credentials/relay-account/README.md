---
description: "Relay account service: register, sign in, and hold the relay session token as a credentials grant."
kind: "package-reference"
---

# @deepseek-ai/dsh-relay-account

English | [中文](README.zh.md)

## Summary

Register and sign in against the relay backend (`/api/user/*`) and keep the session token in the credentials store. Other plugins read the token through `relayAccount.getToken()`; the token never leaves the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Set `apiOrigin` to the backend HTTPS origin. An empty origin leaves the account unconfigured and operations fail with `not-configured`; plain HTTP is accepted on loopback hosts with `allowLoopbackHttp`, and on any host only with `allowHttp`.

`RelayAccount` exposes `getState`, `getToken`, `startSignIn` (browser PKCE authorization through a one-shot loopback callback), `cancelSignIn`, `login`, `register` (optional avatar image), `refresh`, `logout`, and the background-image operations `setBackground`, `readBackground`, and `clearBackground`. State changes emit `relay-account/changed`. The returned `RelayAccountView` carries the profile and expiry but never the token. Failures throw `RelayAccountError` with a code the UI localizes: `not-configured`, `network`, `unauthorized`, `rejected`, `invalid-response`, `invalid-image`, `signed-out`, or `storage`. Avatars and backgrounds must be png, jpg, gif, or webp by content, up to 5 MB.

| Field | Default | Meaning |
|---|---|---|
| `apiOrigin` | `''` | Backend origin serving `/api/user/*` |
| `allowLoopbackHttp` | `false` | Allow HTTP to loopback hosts |
| `allowHttp` | `false` | Allow HTTP to any host (deployments without TLS) |
| `requestTimeoutMs` | `15,000` | Deadline of login, profile, and session requests |
| `uploadTimeoutMs` | `300,000` | Deadline of the registration upload |

<a id="understand-the-implementation"></a>
## Understand the implementation

The session is stored as a `credentials` grant record that also records the backend origin and expiry. `getToken` returns nothing once the stored expiry has passed.

<a id="model-experience"></a>
## Model Experience

None, as the session token authenticates HTTP calls to the relay backend and never enters model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The service does not renew a session before expiry; the user signs in again once it lapses.
- The backend enforces the password policy; the page only checks a minimum length.
