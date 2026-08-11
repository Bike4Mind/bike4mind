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

Every row interaction is explicit and named. A file row carries one
hover-revealed `...` trigger (also revealed on focus-within, always visible on
touch) holding the actions below, and clicking the row itself runs View.

- Add to chat: attach the file to the session workbench, same behavior on both
  chat surfaces - `setWorkBenchFiles` plus a success toast. On `/new` in the
  embedded surface, mint the session first via `createSessionForFile` (existing
  double-click guard stays). With no session and no minting callback
  (external-chat hosts), keep the existing guidance toast.
- Remove: confirm dialog, then `useRemoveFileFromDataLake`, with the Discover
  viewer's copy (the file leaves the lake but stays in Files and existing chats).
- View: reopens the file where it always opened. On the chat-embedded host that is
  the KnowledgeViewer split (`setSessionLayout({ layout: 'vertical' })`), which
  builds its tabs from the session workbench - so View attaches the file too,
  minting the session first on `/new`. External-chat hosts (the overlay, whose
  chat is docked outside this component and would collapse if the global layout
  changed) fall back to an in-rail read-only reader with a Back control that
  restores the tree, breadcrumb intact; that path needs no session and attaches
  nothing.

Revised after review of the first build, where View opened the in-rail reader on
every surface: reading a lake file beside the chat is the behavior people already
had, and losing it to gain attach-free viewing was the wrong trade. The bug being
fixed is browsing mutating the chat, not viewing doing so.

## Known tension

Row click was dead in the first build, then wired to View, so on the embedded
host a click attaches again - the very effect this change set out to remove. What
survives is that nothing happens *silently*: the file opens in the viewer where
the user can see it, instead of quietly joining the chat's files as it used to on
the overlay. Closing the gap properly means teaching KnowledgeViewer to render a
file that is not in the workbench (a preview tab), after which View - and so the
row click - costs no attachment. Until then, Add to chat and View both write to
the workbench and only Remove is side-effect-free.

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

- The auto-attach write (`setWorkBenchFiles`) leaves the click path. What
  `openFileInViewer` did splits in two: `attachFileToChat` behind `[+]` (attach
  plus a success toast, no layout write) and `handleViewFile` behind View (the
  old attach-plus-split, or the rail reader off-host). Both share
  `ensureSessionId`, which owns the `/new` minting and its double-click guard.
- `chatEmbedded` stays: it is what keeps View from switching a global layout that
  an external-chat host has its docked chat inside. The premium guard test
  asserts the overlay never passes it, so the overlay keeps the reader path.
- Deep-linked `?article=` ids go through the same `handleViewFile`, so a link
  opens what View opens.

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
