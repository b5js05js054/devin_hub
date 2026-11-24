---
description: "Composer panel beside the model seat that offers the generation parameters of the selected image or video model."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-media-params

English | [中文](README.zh.md)

## Summary

Adds a settings button beside the composer model seat. It appears only while the selected model is an image or video model, and lets the user set options such as size, quality, duration, resolution, and aspect ratio before sending.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Enable the plugin together with `media-controller` and `llm-relay`; `web-app` enables all three. Pick an image or video model, open the button, and change the options. Defaults apply until the user changes them. When the relay could not confirm the options with the upstream, the panel says so. A chat model shows no button, and a failed lookup shows a retry action.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers a `conversation.input.media` entry. It reads the selected model from the session's model directory, asks `media-controller` for the spec, and stores each choice per session and model through `setParams`. `llm-relay` sends the stored values as a request header. The component takes plain props and callbacks and never sees `ctx`.

<a id="model-experience"></a>
## Model Experience

None, as the values travel in an HTTP header to the relay and never enter prompts, messages, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The panel decides whether a model is an image or video model by asking the relay for its spec on every model change, so a slow relay delays the button.
- Chosen values are not restored after the Host restarts; the panel reloads defaults for the selected model.
