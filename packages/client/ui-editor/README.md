---
description: "IDE panel for the Web sidebar: a file tree, a Monaco code editor that lets you accept or reject the Agent's edits, the Agent conversation and a bottom terminal."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-editor

English | [中文](README.zh.md)

## Summary

Open **IDE** in the Web sidebar to browse the current Session's workspace, edit text files, and watch the Agent work beside the code. Find files by name or text across the whole workspace and jump to the matching line. When the Agent changes an open file, review each change and accept or reject it, or handle the whole file at once. Drag or collapse the three columns, and open a terminal below the editor. Files save only while their on-disk version is unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Select **IDE** in the sidebar. The page binds to the selected Session's workspace and has three columns: the file tree, the editor, and the Agent conversation. A Session without a workspace shows an empty notice.

### Open, edit and save

Click a file to open it in a tab; click a folder to expand it, and use the refresh button to reload the tree. Edit in the editor and press the save shortcut to write the file back. A tab shows a dot while its text differs from the disk. A file that is not UTF-8 text, or is larger than the workspace-files size cap, shows a read failure instead of opening.

If the file changed on disk after you read it, the save is refused and the page shows a conflict notice; nothing is overwritten.

### Search and quick open

Press `Ctrl/Cmd+P` to open a file by name, or `Ctrl/Cmd+Shift+F` to search file contents; the search button in the file column opens the same panel, where you can switch between **Files** and **Content**. Results come from the Host's `search`, so they cover folders you have not expanded. The query is plain text, not a regular expression. Use the arrow keys and `Enter`, or click, to open a result; a content result opens the file at the matching line and column. The search skips version-control and build folders such as `.git`, `node_modules` and `dist`, and a notice says when the results are partial because a limit was reached or something could not be read; an empty result never covers the skipped folders.

### Keyboard

In the file tree, the arrow keys move and fold or expand folders, `Enter` opens, `F2` renames and `Delete` moves the selection to the recycle bin. A tab closes with its close button or a middle click, and the column separators resize with the arrow keys. Closing, renaming or deleting a file with unsaved edits asks you to confirm before discarding them.

### Review the Agent's edits

When the Agent changes an open file and you have no unsaved edits in it, the editor highlights the added and removed lines and shows a review bar. Use **Accept all** or **Reject all** for the whole file, or the **Accept** and **Reject** strip that sits directly above one changed block; changes separated by at most six unchanged lines form one block. Accepting makes the current disk text the new baseline. Rejecting writes the earlier text back for that block.

### Layout and conversation

Drag the separators to resize the file and Agent columns, and collapse either column to a narrow rail. The Agent column embeds the Session's conversation, so you can send instructions and read the Agent's replies without leaving the editor.

### Terminal

Expand the **Terminal** bar under the editor to open a terminal in the Session workspace. Drag the separator above it to change its height. Collapsing the bar hides the terminal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Registration

The plugin registers a root-scoped `main` panel with a sidebar entry, and one session-scoped child slot, `ide.workspace`, that holds the page. Session scope gives each Session its own tabs, drafts and layout through a declared store, so switching Sessions never leaks tabs.

### State and I/O

The page reads and writes only through its store actions and an injected face. The face calls the `workspaceFiles` Remote: `list` for the tree, `read` for file text, `write` with the last-read version for saves, and `changes` to learn that the Agent edited a file. Every disk observation updates the store's `disk` text and version; the `baseline` text is the last text the user accepted.

### Review

`hunks.ts` is a pure line diff between the baseline and the disk text; regions separated by no more than six unchanged lines fold into one reviewable block. Accepting one block copies its disk lines into the baseline; rejecting one writes its baseline lines back to the disk. The diff runs on the main thread, so no Monaco worker is needed.

### Editor

Monaco loads lazily on first open and runs without workers. The build inlines its stylesheet and icon font into the client bundle through the shared client bundler.

### Terminal

The bottom panel renders the `terminal.embedded` factory from the sidebar terminal package, which keeps its terminal attached while mounted.

| File | Contents |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Slot and panel registration |
| [`src/client/IdePage.tsx`](src/client/IdePage.tsx) | Columns, tree, tabs, search panel, review bar, conversation and terminal seats |
| [`src/client/store.ts`](src/client/store.ts) | Per-Session store: tabs, file text, layout |
| [`src/client/face.ts`](src/client/face.ts) | Remote calls, search and file-change handling |
| [`src/client/hunks.ts`](src/client/hunks.ts) | Line diff, accept and reject |
| [`src/client/CodeEditor.tsx`](src/client/CodeEditor.tsx) | Monaco wrapper, change highlighting, per-block review strips and search-result reveal |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the services and slots this panel uses.

- [workspace-files](../../api/workspace-files/README.md) — the Remote that reads, writes and watches the files.
- [ui-sidebar-terminal](../ui-sidebar-terminal/README.md) — the terminal the bottom panel embeds.
- [ui-sidebar](../ui-sidebar/README.md) — the panel list the IDE entry registers into; [ui-layout](../ui-layout/README.md) — the main slot the page occupies.
- [ui-conversation](../ui-conversation/README.md) — the conversation embedded in the Agent column.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side editing surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- A text file only; images and other binary files do not open.
- Editing a file the Agent is changing can end in a conflict notice, because a save is refused when the disk version moved.
- Monaco runs without language workers, so it provides highlighting but no type checking or completion.

<a id="known-limitations-and-deferred-work"></a>

These limits define the reach of the editor; they are current package constraints.

- **Limited file operations** — the tree can create, rename and move files to the recycle bin, but cannot copy or move them between folders, and shows no Git status marks; only existing text files can be saved.
- **One baseline per file** — the review compares the last accepted text with the disk text; there is no per-edit history and no undo of an accepted change.
- **Review needs a clean draft** — while a file has unsaved edits, the page does not show Agent review for it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
