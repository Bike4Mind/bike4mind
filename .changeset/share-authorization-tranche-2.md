---
'@bike4mind/common': minor
'@bike4mind/database': minor
'@bike4mind/services': major
---

Second tranche of the sharing authorization cluster. A grant now means only what it says, and an
entity that derives grants cleans them up when it goes away.

Re-sharing is capped and gated. An invite can no longer carry a permission its minter does not
hold, so a sharee with `share` alone cannot mint `update`/`delete` and redeem the link on their own
account; `@bike4mind/common` exports `heldPermissions` and `grantablePermissions` for that check.
The cap uses the latter, which treats `share` as conveying `read`: minting an invite already
requires share authority, and a collaborator granted share alone still has to be able to pass on
the read that share implies. Flipping `isGlobalRead`/
`isGlobalWrite` publishes a document to the whole instance, so it moves from the update predicate
to the share predicate. Project invite listing moves to the share predicate too, since it exposes
link-invite ids and pending invitees' email addresses. Accepting a session invite propagates a
grant to an attached file only when the inviter holds share on that file, capped at what they hold;
invites gain an optional `inviterId` to make that check possible, and a legacy invite without one
falls back to propagating only to the session owner's own files.

Revocation and deletion now cascade. The project-scoped revoke filter removed every entry carrying
the target `projectId` rather than only the target user's, so one member leaving stripped every
co-member's access. Deleting a project strips the grants it left on its files and sessions.
Revoking a session share also removes the file grants acceptance materialized. Deleting a session
hard-deletes only the owner's own files; an attached file owned by someone else loses the derived
grant instead of being destroyed.

A shared entry now records the grant's source. `pushShareable` keyed `users[]` on `userId` alone,
so a file reached through two projects collapsed into one entry tagged with whichever project
wrote last, while `revoke` filters on that tag: revoking via the earlier project matched nothing
and returned the document as if it had succeeded, leaving access live, and revoking via the later
one tore out the other project's grant as well. Entries are keyed on `(userId, projectId)`, so each
project's grant and any direct share are separate rows, and a scoped revoke that matches no row now
raises `NotFoundError` instead of reporting a success that removed nothing. That last part guards a
future scoped caller more than a present one: the only code passing a `projectId` today is
`revokeFromProject`'s own cascade, which swallows `NotFoundError` by design, and the HTTP route
never sends one. Rows written before
this change carry only the last project's tag; a scoped revoke against an earlier project hits the
new not-found path, and revoking without a `projectId` still clears every row the user holds. A
user may now legitimately hold several rows on one document, so the client-side permission helpers
in `apps/client/app/utils/userPermission.ts` union across them instead of reading the first match,
matching the `$elemMatch` predicates and `heldPermissions` server-side.

The db-core CASL ability was missing `Project` from its shared user/group permission arm while the
HTTP copy carried it, so a project shared with a user was unreachable through every caller that
builds an ability from `@bike4mind/database` rather than `@server/auth/ability` (the quest,
slack-quest, image-edit, image-generation and video-generation queue handlers). Both copies now
grant the same resource set, and a structural test reads the two files and fails if they drift.

An invite now records whether it names anybody. Project and Organization invites carry raw user
ids (the add-members modals send `recipients: [userId]`), and `findAllByEmailsOrUsernames` queries
email and username only, so their `recipients.pending` always persisted as `[]`. Every gate keyed
on `pending.length` therefore fell open for exactly those two types: any authenticated caller
holding the invite id could read its contents, and could accept it and join the project or
organization with grants on every file and session inside. `createInvite` resolves id-shaped
recipients through `findByIds`, refuses to mint an invite whose recipients all fail to resolve, and
persists an `isLinkOnly` flag; `canViewInvite` and the accept-time recipient gate key on that flag
via `isLinkOnlyInvite` (`@bike4mind/common`) rather than on an empty `pending`. Invites minted
before the flag fall back to inferring it, and only for FabFile and Session, whose recipients always
did resolve to emails - so a legacy Project or Organization invite fails closed at both gates and
has to be re-sent. A side effect worth knowing: organization seat accounting counts pending
recipients, so it was undercounting and now holds.

Revoking a session share cascades on share authority rather than ownership. Acceptance propagates a
file grant whenever the inviter can share the file, so gating the revocation on the session owner
*owning* it left grants on shared-but-not-owned files permanently un-revokable through the session
path. Both sides now use `heldPermissions`, which returns everything for an owner, so ownership
still passes.

Deleting a session cascades before it tombstones, and drops only the grant it created. The tombstone
came first while the per-file grant rewrite came second, and `softDeletePlugin` puts
`deletedAt: null` on every `findOne` - so a failure mid-cascade left the session unreachable on a
retry with the remaining grants live and nothing left to clear them. The cascade now runs first.
It also qualifies on `(userId, projectId)` like its sibling in `sharingService/revoke.ts`: it was
stripping every row the deleter held, so a file reached through a project the deleter is still a
member of lost that access too. Both new whole-document grant writes, here and in the session
knowledge-file cascade, take `updateGuarded` rather than `update`, joining the optimistic-concurrency
convention the revoke path already uses.

Deleting a project revokes the owner's own derived grants. `addFiles`/`addSessions` mint the project
owner a `projectId`-scoped read+update grant on content a MEMBER contributes, but the owner is never
in `project.users`, so the per-member cascade never reached those and they outlived the only surface
that could revoke them.

A Project or Organization invite can no longer be minted with no recipients. Neither type is
shareable by link, so an empty list would otherwise persist `isLinkOnly: true` and be redeemable by
anyone holding the id. The flag is type-aware too, so it agrees with `isLinkOnlyInvite`'s legacy
inference rather than contradicting it.

The CASL share arm is now one exported function, `applySharedShareableRules`, called by both ability
builders instead of being hand-copied. Each caller still passes its own resource list, because CASL
matches subjects by constructor and a shared list would close over db-core's models; list drift is
what the structural test compares, and body drift is no longer possible. `findAllAccessibleByIds`
declares the `Pick<IUserDocument, 'id' | 'groups'>` it actually consumes, matching
`findAllUpdateAccessByIds` and removing two casts at the `createProject` call site.
`GET /api/invites/[id]` validates the id shape before `findById`, matching its sibling route.
Migration 20260912000000 backfills `Invite.inviterId` from the username every invite already
persists, which is the closing move for the legacy propagation fallback in `accept.ts`.

Invite redemption enforces `expiresAt` on both accept and refuse. Declining now affects only the
decliner's own slot: one recipient declining used to zero the invite for every other recipient, and
any holder of a link id could do the same. Whole-invite revocation requires the same authority
`cancelInviteById` enforces. `GET /api/invites/[id]` and `GET /api/[type]/[id]` no longer return an
invite's contents to any authenticated caller holding the id; a caller who fails the gate gets 404,
not 403, so the response does not confirm the id exists.

Ids supplied by the caller are resolved before they are persisted. Project creation and
`addSessions` write only the ids that resolved through the caller's access predicate, so a project
can no longer carry a file or notebook the creator cannot reach. The favorites list intersects
against currently-held access rather than trusting the stored row, so a notebook stops appearing
once its share is revoked.

Breaking, in `@bike4mind/services`: `createProject` takes the acting user (`Pick<IUserDocument,
'id' | 'groups'>`) instead of a bare user id, and requires `fabFiles` and `sessions` adapters;
`refuseWholeInvite` takes a full `IUserDocument` and the adapters `authorizeByInviteType` needs;
`deleteProject` requires `sessions`, `fabFiles` and `users` adapters to run its cascade.
