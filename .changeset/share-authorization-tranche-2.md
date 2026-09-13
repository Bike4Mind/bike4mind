---
'@bike4mind/common': minor
'@bike4mind/database': minor
'@bike4mind/services': major
---

Second tranche of the sharing authorization cluster. A grant now means only what it says, and an
entity that derives grants cleans them up when it goes away.

Re-sharing is capped and gated at the invite door. An invite can no longer carry a permission its
minter does not hold, so a sharee with `share` alone cannot mint `update`/`delete` and redeem the link on their own
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

A shared entry now records the grant's source, for sessions as well as projects. `pushShareable`
keyed `users[]` on `userId` alone,
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

A session's knowledge propagation now tags the grants it mints, and both cascades key on that tag.
`IUserShare` gains an optional `sessionId`, the counterpart to `projectId` for the other entity that
derives grants, and `pushShareable` keys on all three. Untagged, a propagated file grant merged into
any direct share of the same file to the same user - so unsharing the session deleted the merged row
whole and destroyed a grant a third party had made. Reaching that row through the session also
skipped the owner-or-self check a direct `revokeSharing` on the file would have applied, since the
cascade writes `file.users` itself. Keying on the tag fixes both: a direct share is its own row and
is never touched, and a tagged row can only have been written by an accept that already required the
inviter to hold share on the file, so the tag *is* the authorization. That retires the previous
gate, which asked whether the SESSION OWNER could still share the file while the mint had asked
about the INVITER - not the same principal whenever a sharee minted the invite, which stranded those
grants un-revokable through the very path that created them. Grants written before the tag existed
are untagged and so are no longer reachable from the session path; they remain revocable directly on
the file, which is the safe direction to fail.

Deleting a session cascades before it tombstones, and drops only the grant it created. The tombstone
came first while the per-file grant rewrite came second, and `softDeletePlugin` puts
`deletedAt: null` on every `findOne` - so a failure mid-cascade left the session unreachable on a
retry with the remaining grants live and nothing left to clear them. The cascade now runs first.
It also keys on the `sessionId` tag like its sibling in `sharingService/revoke.ts`, and clears every
grantee's tagged row rather than only the deleter's: it was stripping every untagged row the deleter
held, which took direct shares with it and left sharees' derived grants behind with no surface left
to revoke them. It reads `knowledgeIds` as well as files uploaded into the session, since a grant the
session minted can sit on a file that lives elsewhere. Both new whole-document grant writes, here and in the session
knowledge-file cascade, take `updateGuarded` rather than `update`, joining the optimistic-concurrency
convention the revoke path already uses.

Deleting a project revokes the owner's own derived grants. `addFiles`/`addSessions` mint the project
owner a `projectId`-scoped read+update grant on content a MEMBER contributes, but the owner is never
in `project.users`, so the per-member cascade never reached those and they outlived the only surface
that could revoke them. Making that pass reachable meant taking a hidden mutation out of
`revokeFromProject`: it pruned the caller's live `project.fileIds`/`sessionIds` as it went, so by the
time the owner pass ran, the member-owned documents carrying the owner's grants had already been
removed from the list it reads. It now returns the pruned ids and leaves the caller's document alone.
`leaveProject` and the project arm of `revoke` assign the return; `deleteProject` drops it, so a
tombstoned project still records what it held for restore and audit to read.

The legacy link-only inference reads all three recipient buckets. Accepting and declining both move
an address out of `pending`, so unioning only `pending` and `accepted` made a pre-flag invite whose
named recipients had all declined infer as a share link - opening the view gate to any authenticated
caller and letting anyone redeem it. `refused` is unioned too.

An invite of a type that is not shareable by link can no longer be minted with no recipients. Only
FabFile and Session are: for Project and Organization an empty list would otherwise persist
`isLinkOnly: true` and be redeemable by anyone holding the id, and for Group it persisted
`isLinkOnly: false` against an empty `pending`, which both the view gate and the accept gate then
refuse - a row that minted successfully and nobody could ever redeem. The refusal is expressed
against the same predicate that sets the flag, so the two cannot drift apart. `InviteType.Tool` has
no arm in `createInvite`'s switch and still fails earlier, on `Document not found`. A Group invite
naming only recipients that fail to resolve is refused too, matching the Project/Organization arm
that already did: it persisted a row both gates then refuse, while telling the sharer it worked.

The CASL share arm is now one exported function, `applySharedShareableRules`, called by both ability
builders instead of being hand-copied. Each caller still passes its own resource list, because CASL
matches subjects by constructor and a shared list would close over db-core's models; list drift is
what the structural test compares, and body drift is no longer possible. `findAllAccessibleByIds`
declares the `Pick<IUserDocument, 'id' | 'groups'>` it actually consumes, matching
`findAllUpdateAccessByIds` and removing two casts at the `createProject` call site.
`GET /api/invites/[id]` validates the id shape before `findById`, matching its sibling route.
The `backfill-invite-inviter-id` migration backfills `Invite.inviterId` from the username every
invite already persists, which is the closing move for the legacy propagation fallback in
`accept.ts`. It scans on an `_id` cursor rather than loading the whole matching set at once, since
invites are one of the higher-cardinality collections. `SkillShareDialog`, the surface that actually
flips `isGlobalRead`/`isGlobalWrite`, reports the server's reason instead of a fixed string, so a
holder refused by the predicate this change moves can tell that apart from a network failure.

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
`deleteProject` requires `sessions`, `fabFiles` and `users` adapters to run its cascade;
`revokeFromProject` returns `{ fileIds, sessionIds }` and no longer writes them back onto the
`project` it was handed, so a caller that relied on the mutation must assign the return itself. In
`@bike4mind/common`, `IUserShare` gains an optional `sessionId`, and any code that reads `users[]`
must treat a row carrying it as distinct from an untagged row for the same user.
