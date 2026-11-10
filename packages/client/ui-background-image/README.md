---
description: "Settings section that lets the user set a local background image for the application window."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-background-image

English | [中文](README.zh.md)

## Summary

Adds a Background section to Settings where the user picks a picture to show behind the app, removes it, and sets how opaque the panels are over it. The picture is stored in this browser's IndexedDB and is never uploaded.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Enable the plugin; `web-app` enables it. Open Settings, choose Background, and pick an image file of up to 30 MB. Larger photos are resampled so the longest edge is at most 2560 pixels. The slider sets how opaque the main panel and the sidebar are over the picture. Removing the picture restores the normal theme.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin registers a `settings.section` entry and owns one controller. The controller reads the saved picture and opacity from IndexedDB at startup, publishes a snapshot to the section, and applies the result to `document.body`: the `data-dsh-bg-image` attribute plus the `--dsh-bg-image` and `--dsh-bg-panel` custom properties. A plugin-owned stylesheet paints the picture on a fixed layer behind the page and, only while the attribute is present, overrides `--dsw-alias-bg-base` and `--dsw-specific-sidebar-fill` with translucent versions. Disposing the plugin removes the attribute, the properties, and the stylesheet.

<a id="model-experience"></a>
## Model Experience

None, as the picture is browser presentation and never enters prompts, messages, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the main ground and the sidebar turn translucent. Other panels keep their opaque layer colors, so the picture shows through only in those two areas.
- The picture lives in one browser profile on one device; it does not follow the user to another browser or the desktop app.
