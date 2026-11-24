# Agent Note: Client-owned versions for upstream syncs

Status: implemented

English | [中文](2026-11-20-client-rc6-upstream-sync.zh.md)

## Problem

The Client follows the upstream DSH repository while keeping a different product architecture and release history. Copying an upstream version during a source sync would make the Client's release sequence depend on another repository, while a broad port would obscure which behavior was selected.

## Decision

The Client owns a monotonically increasing dsh version sequence ([release policy](2026-08-10-npm-release-sequences.md)). An upstream tag identifies the source baseline only; it does not select or replace the Client version. Every upstream sync records the Client version and exact included and excluded scope. Client `0.2.2-rc.6` takes changes from `dsh-v0.2.2-rc.5`. Client `0.2.2-rc.7` takes changes from `dsh-v0.2.3-alpha.1`.

### Included in 0.2.2-rc.6

| Area | Scope |
|---|---|
| Markdown file destinations | Preserve Windows separators through both Markdown parsers; parse line, range, and column suffixes while retaining URL-scheme and UNC restrictions. Regression coverage is in `packages/client/ui-primitives/tests/markdown-file-links.client.spec.tsx`; update the bilingual package README and pairing record with the accepted suffixes and restrictions. |
| Wide Markdown tables | Retain the hover-capability scrollbar rule in `packages/client/ui-primitives/src/markdown/MarkdownText.module.css` and touch-only horizontal-scroll coverage in `apps/web/tests/markdown-wide-table.e2e.ts`. |
| Desktop authentication cleanup | The origin-scoped legacy Host-cookie implementation already matched upstream. Add startup coverage for deletion through Electron's default session and nonfatal cleanup failure in `apps/desktop/tests/main-startup.spec.ts`. |
| Native directory chooser | The chooser implementation already matched upstream. Add generated JXA tests for selection, cancellation, and empty selection in `packages/host/directory-picker-native/tests/native-picker.spec.ts`. |
| Release manifests | Set the workspace root and all 357 app/package manifests selected by `release:dsh` to `0.2.2-rc.6` (358 targets total). Declare the existing `micromark-util-decode-string` package in `packages/client/ui-primitives/package.json` and its lockfile importer. |

`packages/client/ui-primitives/src/useModalLayer.ts` already matched upstream; focus restoration is retained without a source port. The paired package README records the supported path suffixes, URL restrictions, and UNC rejection for consumers.

### Excluded from 0.2.2-rc.6

| Upstream change or area | Decision |
|---|---|
| Agent Team and task-board architecture | Do not replace the Client's experimental roster, mailbox, tools, UI, or persistence model with upstream's subagent-owned task board. |
| Plugin management and terminal UI | Do not replace the dynamic plugin runner or core terminal. Upstream Plugin Manager additions and the Agent-terminal sidebar are separate feature work. |
| Node engine floor | Keep `^22.19.0 || >=24.0.0`. Upstream's `>=24.9.0` would drop Node 22 and Node 24.0-24.8 from the supported range. |
| Other Markdown presentation changes | Defer optional `omitHtml`, TeX-aware copy, and CJK autolink; they are not required for the selected path fixes and involve separate rendering or dependency concerns. |

### Scope of 0.2.2-rc.7

- An empty composer lets the user browse text sent in the current Session with the arrow keys. Recall preserves drafts, attachments, and IME composition.
- Copy controls try the legacy clipboard command after an asynchronous write is denied and restore keyboard focus. Desktop clears the inherited Electron Node-mode flag when launching external applications such as VS Code or Cursor.
- `read` and `glob` retain only the selected lines or paths, allowing the original large file or search output to be collected.
- DeepSeek image uploads encode the complete multipart body before sending it, so the runtime remains available when the caller cancels a starting upload.
- Single-file distributions launch the JSONL migration verifier with an absolute Worker path when reopening older Sessions.

This release keeps the Client's IDE, account licensing, model relay, expert orchestration, Desktop update channels, and existing Node support range. The upstream Session panel, code reviews, connectors, SQLite Session store, and default PTC mode are deferred to separate integrations.

## Alternatives considered

**Copy upstream's release version.** Rejected: source synchronization does not transfer ownership of the Client's published sequence; an explicit Client version gives each Client artifact a unique, reviewable release version.

**Port every upstream feature in one batch.** Rejected: the team, plugin, and terminal implementations have materially different ownership and persistence models. Importing them together would expand this sync into unrelated product work.

**Raise the Client Node floor to match upstream.** Rejected: Node `^22.19.0` and Node `24.0` through `24.8` remain in the declared Client support range, with no decision to drop them.

## Consequences

Version `0.2.2-rc.6` covers the 358 manifests in the `release:dsh` shared-version plan: the workspace root and 357 app/package manifests. This plan includes private workspaces whose package names are outside the `@deepseek-ai/dsh-*` pattern. It does not update the Client Node engine range or imply that deferred upstream features are unsupported forever. Future sync records identify their upstream baseline and selected scope; the release sequence remains Client-owned.
