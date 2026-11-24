---
description: "Browser packages: the built-in browser tool and the registration service for experimental browser backends."
kind: "package-group"
---

# packages/browser-use

English | [中文](README.zh.md)

## Summary

This group lets models inspect and operate web pages. The built-in `browser` tool drives the user's installed Chrome or Edge and is mounted by the default agent presets. The group also owns exclusive registration for experimental providers, which supply their own browser tools and manage each Session's browser resources.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The built-in tool needs no provider. To use an experimental provider instead, choose one and mount the shared registration service.

| Package | Role | ctx key |
|---|---|---|
| [`browser-use`](browser-use/README.md) | Exclusive named provider registration | `ctx.browserUse` |
| [`tool-browser`](tool-browser/README.md) | Built-in `browser` tool over the packaged agent-browser CLI | — |

<a id="related-documentation"></a>
## Related documentation

- [Browser use](../../docs/subsystems/browser-use.md) — capability ownership and provider choices.
- [Experimental packages](../experimental/README.md) — Playwright MCP, Chrome DevTools MCP, and Stagehand providers.

<a id="dev-note"></a>
## Dev Note

None.
