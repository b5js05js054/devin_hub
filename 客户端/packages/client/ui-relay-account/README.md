---
description: "Settings page to register, sign in, and manage the relay card-key license."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-relay-account

English | [中文](README.zh.md)

## Summary

Adds a Relay account section to Settings. Signed out, it offers sign-in and registration (email, password, optional avatar). Signed in, it shows the benefit pack (free-model entitlement) and the balance (premium-model wallet) as separate cards, supports activation codes and top-up redemption, and embeds a shop that sells benefit packs for balance or activation codes. The account menu and the usage section open the website’s user center for personal usage, model prices and the opt-in leaderboard. While an account is signed in, the plugin also shows the announcement the operator publishes as a banner at the top of the window.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Enable the plugin together with `relay-account`, `relay-license`, and `relay-controller`; `web-app` enables all four. The section follows the Remote `relay.watch` stream. Rejections show the backend message; network, expiry, and image failures show localized copy. Before calling the Host, the page checks the email form, a minimum password length of 6, and the confirmation.

The announcement banner needs no configuration. It shows the title, text, and level the operator publishes in the backend admin, appears within about five seconds of being enabled, follows edits, and disappears once the operator withdraws it. Closing the banner hides that announcement on this device until its title, text, or level changes, or until it is withdrawn and published again.

<a id="understand-the-implementation"></a>
## Understand the implementation

The component takes plain props and callbacks and never sees `ctx`. The plugin owns the stream subscription and publishes one snapshot to the component. Changing accounts discards card-code drafts and shop results. The signed-in view supplies the user-center link. The browser uses its own website session to read usage.

The announcement watcher asks the Remote `relay.announcement` as soon as a signed-in session appears and again five seconds after each answer, so checks never overlap. It pauses while the page is hidden and asks at once when the page is shown again. A failed check leaves the banner as it is; a `signed-out` or `unauthorized` answer hides it and stops the checks until another session arrives. The banner registers into `shell.overlay`, and the closed announcement is remembered in the browser's `localStorage`.

<a id="model-experience"></a>
## Model Experience

None, as the page is browser presentation and contributes no prompt, message, schema, or tool result.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The avatar is read into memory and sent as base64; the Host enforces the size limit.
- The page has no password-reset flow because the backend exposes none.
- The backend answers the announcement only to a signed-in account, so a signed-out client shows none.
- Every signed-in client with a visible page asks the backend every five seconds; the interval is fixed in the client and the backend cannot change it.
- A closed announcement is remembered per device, not per account.
