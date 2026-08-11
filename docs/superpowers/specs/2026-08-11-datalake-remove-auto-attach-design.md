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
- View: opens the file in the KnowledgeViewer on every chat surface, attaching it
  on the way (the viewer builds its tabs from the session workbench, so a file
  with no workbench entry has no tab) and minting the session first on `/new`.
  Only the route onto the screen differs, and only where it must:
  - Chat embedded: `setSessionLayout({ layout: 'vertical', selectedArtifactId })`
    and the chat's own SessionContainer renders the viewer.
  - External-chat host (the overlay): the chat is docked (`dockRight`), a mode in
    which SessionContainer renders no viewer, and the layout cannot be used to get
    one - `vertical` collapses the dock and the host force-redocks anything else.
    So only `selectedArtifactId` is set and the explorer mounts its own viewer in
    the rail (`autoHideOnEmpty={false}`, or the viewer would push the layout to
    `hide` and take the dock with it), with a Back control that restores the tree.

Revised twice after seeing the first build: View opened an in-rail markdown reader
on every surface, which took away reading a file beside the chat, and then opened
the split on the embedded host only, which left the overlay behaving differently.
Reading a lake file where it has always appeared is the behavior people already
had; the bug being fixed is browsing mutating the chat, not viewing doing so.

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

- The silent auto-attach leaves the click path. What `openFileInViewer` did splits
  in two: `attachFileToChat` behind Attach to chat (attach plus a success toast,
  no layout write) and `handleViewFile` behind View. Both share `ensureSessionId`,
  which owns the `/new` minting and its double-click guard.
- `chatEmbedded` stays: it is what keeps View from switching a global layout that
  an external-chat host has its docked chat inside. The premium guard test asserts
  the overlay never passes it, so the overlay keeps the rail-mounted viewer.
- Deep-linked `?article=` ids go through the same `handleViewFile`, so a link
  opens what View opens.

## Testing

- `DataLakeExplorer.test.tsx`: the explorer writes nothing until an action runs;
  which gesture triggers which action is the tree's contract.
- Attach (existing session / `/new` minting / no-session toast / create
  rejection); View on the embedded host sets `layout: 'vertical'`, on an
  external-chat host mounts the rail viewer and sets ONLY `selectedArtifactId`;
  Back restores the tree; deep-link behaves as View; delete gating (meta-tag
  resolution, `canManage` true/false, fallback lake); confirm dialog wired to the
  mutation.
- Tree chrome tests: a row click runs View, an actions-menu click does not, the
  trigger is frameless, and the menu's items gate on `canDeleteFile`.

## Known follow-up (not this change)

The removal endpoint authorizes with `assertLakeAccess` + `assertLakeWritable`
only - any reader of a lake can delete its files via the API while the UI now
implies manage-only. Server-side gating deserves its own fix.
