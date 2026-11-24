---
kind: upgrade-guide
description: "Relay credentials now require an authenticated account session and do not adopt device-only legacy assets."
---

# Relay account asset ownership

English | [中文](guide.zh.md)

## Change

Relay license records are scoped to the backend origin and authenticated account session. Signing out or changing accounts stops access to the prior account’s token, balance, plan, shop results, and usage. Device-only legacy license records are retained but never assigned to the current account.

The relay requires a signed account ID matching its wallet code, device claim, license scope, and expiry. The backend retains device limits on plan cards while sharing the wallet across the same account’s devices. Unknown historical card balances and ownership are not automatically merged or claimed.

## Migration

Back up the backend database and request logs, then coordinate backend, relay, and client deployment with matching license secrets and the relay admin API URL. Sign in again to restore the server-owned wallet. Existing device-only tokens require renewal; administrators must verify historical ownership and payment records before any manual asset reconciliation. Device unbinding preserves the account owner, and deleting an account disables its assets while retaining its identity ID.

See the [license package](../../../../packages/credentials/relay-license/README.md) for client credential handling.
