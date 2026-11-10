---
description: "LLM route that sends model requests through the user's card-key relay server using its OpenAI-compatible endpoint."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-relay

English | [中文](README.zh.md)

## Summary

Register the `relay` route. Requests go to the relay server's `/v1/chat/completions`, authenticated with the license token from `relayLicense`, and the model list comes from `/v1/models`, so the client neither hard-codes nor substitutes models.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Set `relayURL` to the relay server origin; a trailing `/v1` is accepted. Activate a card key first.

```yaml
- id: llm-relay
  name: '@deepseek-ai/dsh-llm-relay'
  config:
    relayURL: https://relay.example.com
```

| Field | Default | Meaning |
|---|---|---|
| `relayURL` | required | Relay server origin |
| `displayName` | `Relay` | Name shown in model pickers |
| `modelsMaxAgeMs` | `600,000` | Listing age after which the next access refreshes it |
| `modelsTimeoutMs` | `10,000` | Deadline of one listing request |

<a id="understand-the-implementation"></a>
## Understand the implementation

The route wraps `PiAiAdapter`. The license token is supplied as the per-request key and the listing is cached in memory.

<a id="model-experience"></a>
## Model Experience

### Relay model requests

#### What the model sees

Requests on the `relay` route add no model-visible text from this plugin; the shared OpenAI-compatible transport serializes requests and the relay server forwards them.

#### Token effect

The route adds no input tokens. The relay `/v1/models` listing sets each model's context window and output cap.

#### KV Cache effect

The license token and the listing do not enter model input; the transport owns request-prefix serialization.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The listing cache lives in memory; a start without network exposes no models until a listing loads.
- The relay server decides billing, quota, and channel failover; this route reports their errors.
