# Data Lake tree: remove auto-attach, add explicit row actions

Date: 2026-08-11
Status: approved

## Problem

Clicking a file in the Data Lake tree silently attaches it to the current chat
session. Product feedback classified this as a bug: browsing must not mutate the
chat's attachments. Today's behavior, both driven by the same
`openFileInViewer` path in `DataLakeExplorer`:

- Chat-embedded surface (`DataLakeChatSurface`, passes `chatEmbedded`): click
  attaches the file to the session workbench AND opens the KnowledgeViewer
  split (`setSessionLayout({ layout: 'vertical', ... })`).
- External-chat hosts (chatSlot without `chatEmbedded`, e.g. the OptiHashi
  surface): click attaches to the workbench and shows a toast; no viewer opens.

The attach exists because the KnowledgeViewer builds its tabs from the
workbench list, so an unattached file had no tab to show. That coupling drove
the whole interaction.

## Decision

File click does nothing. All row interactions move to explicit,
hover-revealed controls (also revealed on focus-within for keyboard users) on
file rows of the chat-mode trees only:

- `[+]` Add to chat (direct icon button): attach the file to the session
  workbench, same behavior on both chat surfaces - `setWorkBenchFiles` plus a
  success toast. On `/new` in the embedded surface, mint the session first via
  `createSessionForFile` (existing double-click guard stays). With no session
  and no minting callback (external-chat hosts), keep the existing guidance
  toast.
- `[x]` Remove from lake (direct icon button, confirm dialog): reuse
  `useRemoveFileFromDataLake` and the Discover viewer's confirm copy (the file
  leaves the lake but stays in Files and existing chats).
- `...` menu with a single item, View: swap the tree rail content to an inline
  read-only reader (reusing the `DataLakeArticle` renderer) with a Back control
  that restores the tree, breadcrumb intact. Viewing requires no session and
  never touches the global session layout, so it works identically on both
  surfaces and on `/new`.

Out of scope: the `/data-lakes` page mode and the Discover modal tree keep
their current behavior (neither auto-attaches). The premium overlay needs no
change; it already renders `DataLakeExplorer` without `chatEmbedded`.

## Delete gating

The chat tree is cross-lake, but the removal endpoint is per-lake
(`DELETE /api/data-lakes/[id]/files/[fabFileId]`). Resolve the owning lake
client-side: match the file's `datalake:` membership meta-tag(s) against the
cached `useGetDataLakes` list. Render `[x]` only when exactly one lake resolves
AND it has `canManage`. Consequences, both intended:

- Built-in fallback lakes (owner-less, `assertLakeWritable` rejects writes)
  never show delete - `canManage` is false for them.
- Prefix-only files (in the tree by taxonomy tag, no membership meta-tag) never
  show delete - ownership is ambiguous.

## Removals

- The auto-attach write (`setWorkBenchFiles`) leaves the click path;
  `openFileInViewer` becomes the attach handler behind `[+]` (rename to match,
  drop its `setSessionLayout`/toast branching).
- The `chatEmbedded` prop is deleted end to end: with no KnowledgeViewer split
  to open, both of its uses (opening the split; resetting it in
  `handleNavigate`) disappear. `DataLakeChatSurface` stops passing it; its test
  drops the assertion. The premium guard test asserts the prop's absence, so it
  stays green.
- Deep-linked `?article=` ids in chat mode open the inline reader instead of
  attaching.

## Testing

- `DataLakeExplorer.test.tsx`: invert the click assertions - a file click must
  not call `setWorkBenchFiles`, `setSessionLayout`, or toast.
- New: `[+]` attaches (existing session / `/new` minting / no-session toast);
  View swaps rail to reader and back without attaching or minting; deep-link
  opens the reader without attaching; `[x]` gating (meta-tag resolution,
  `canManage` true/false, fallback lake); confirm dialog wired to the mutation.
- Tree chrome tests: hover controls render, clicks do not bubble to the row.

## Known follow-up (not this change)

The removal endpoint authorizes with `assertLakeAccess` + `assertLakeWritable`
only - any reader of a lake can delete its files via the API while the UI now
implies manage-only. Server-side gating deserves its own fix.
