---
'@bike4mind/common': major
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
one tore out the other project's grant as well. Entries are keyed on `(userId, projectId, sessionId)`,
so each project's grant, each session's, and any direct share are separate rows, and a scoped revoke that matches no row now
raises `NotFoundError` instead of reporting a success that removed nothing. No first-party caller passes a
`projectId` except `revokeFromProject`'s own cascade, which swallows `NotFoundError` by design, but
the `revokeSharing` route accepts one in its body - so a client that supplies a `projectId` matching
none of the target's rows now gets a 404 instead of the broad revoke it probably meant. That is the
fail-closed direction, and it is the point: the old behaviour reported success and removed nothing.
Rows written before
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
recipients through `findByIds` (a new requirement on its `users` adapter, alongside the
`findAllByEmailsOrUsernames` and `findById` it already took), refuses to mint an invite whose
recipients all fail to resolve, and persists an `isLinkOnly` flag; `canViewInvite` and the accept-time recipient gate key on that flag
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
grants un-revokable through the very path that created them.

Grants written before the tag existed are untagged and so are not reachable from either cascade.
This is under-revocation, and it is the safe direction to fail - the alternative is the third-party
destruction above - but it is not costless, and the honest statement of the residue is narrower than
"revoke it on the file instead". Where the session owner does not own the file, they have no
surface at all: an unscoped revoke on the file is owner-or-self, so only the file's owner or the
grant holder can clear it, and neither of them is the person who wanted the access gone. No backfill closes this from
code alone: an untagged row is indistinguishable from the direct share this change exists to
protect, so tagging it re-creates the bug and adding a second tagged row leaves the untagged one
live. Reconstructing provenance from accepted-invite history does not substitute, because a grant
outlives the invite that created it and can predate the address it would be keyed on; a gate on the
session owner holding `share` authorizes the wrong principal, since the mint reads the inviter. It is
not a regression either - before this change neither cascade existed at all, so those rows were
already unreachable from this surface. The gap shrinks as legacy grants are revoked on the file. Closing
the rest is tracked as its own follow-up, `sharing: owner-facing surface to list and clear untagged
grant rows`, which is a UI plus a scoped revoke endpoint rather than a backfill that guesses at
provenance.

Deleting a session cascades before it tombstones. The tombstone came first while the per-file grant
rewrite came second, and `softDeletePlugin` puts `deletedAt: null` on every `findOne` - so a failure
mid-cascade left the session unreachable on a retry with the remaining grants live and nothing left
to clear them. The cascade now runs first, and both live entry points - `DELETE /api/sessions/[id]` and the bulk
route - wrap each call in a transaction, so a concurrency conflict partway through rolls back rather
than leaving some files rewritten and some not; that matches the `revokeSharing` route, which
already wrapped the sibling cascade. The bulk route wraps per session rather than around its loop,
because it is best-effort: one session failing must not roll back the ones already deleted.

What that cascade touches, precisely: rows tagged with this session, on the union of files uploaded
into it and files named in `knowledgeIds` (neither set contains the other), for every grantee rather
than only the deleter, skipping files the deleter owns because those are deleted moments later and a
guarded write on them can abort the delete for nothing. That delete is `deleteManyInIds`, the
soft-delete plugin's tombstone path rather than a hard delete, so the skipped rows survive on the
tombstoned document; no read path reaches them, since every FabFile aggregate filters `deletedAt`
and none projects `users`, and the one `includeDeleted` read that returns `users[]` is admin-only. Its reach is bounded by `knowledgeIds` as of the call, which is
client-writable, so a sharee holding update on the session can detach a file first and keep the
grant; closing that needs a `users.sessionId` sweep across a high-cardinality collection and is not
paid here. Both new whole-document grant writes, here and in the session knowledge-file cascade,
take `updateGuarded` rather than `update`, joining the optimistic-concurrency convention the revoke
path already uses. Mint paths still use a plain `update`; guarding those remains a separate change.

Deleting a project revokes the owner's own derived grants. `addFiles`/`addSessions` mint the project
owner a `projectId`-scoped read+update grant on content a MEMBER contributes, but the owner is never
in `project.users`, so the per-member cascade never reached those and they outlived the only surface
that could revoke them. Making that pass reachable meant taking a hidden mutation out of
`revokeFromProject`: it pruned the caller's live `project.fileIds`/`sessionIds` as it went, so by the
time the owner pass ran, the member-owned documents carrying the owner's grants had already been
removed from the list it reads. It now returns the pruned ids and leaves the caller's document alone.
`leaveProject` and the project arm of `revoke` assign the return; `deleteProject` drops it, so a
tombstoned project still records what it held for restore and audit to read.

The legacy link-only inference reads all three recipient buckets, and is permanent: rows minted
before `isLinkOnly` existed never gain the flag, so the fork stays until none are left. Its safety
also depends on `remaining`, which is documented at the predicate rather than left implied. Accepting and declining both move
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
declares the `Pick<IUserDocument, 'id' | 'groups'>` it actually consumes, which removes two casts at
the `createProject` call site. Its sibling `findAllUpdateAccessByIds` still takes a full
`IUserDocument` and is unchanged here.
`GET /api/invites/[id]` screens the id shape before `findById` and answers a malformed id with the
same 404 as a missing or unauthorized one, so the status never tells a caller which ids exist.
The `backfill-invite-inviter-id` migration backfills `Invite.inviterId` from the username every
invite already persists, which is the closing move for the legacy propagation fallback in
`accept.ts`. It scans on an `_id` cursor rather than loading the whole matching set at once, since
invites are one of the higher-cardinality collections. Because `username` is mutable and the only
reader of `inviterId` is an authorization gate, the backfill is narrowed twice: to Session invites,
the only type that gate runs for, and to resolutions where the account still OWNS the target
session. Not merely holds a grant on it: minting a Session invite is owner-only, so a sharee can
never be the inviter, and admitting grant holders would readmit the squatter case the narrowing
exists to exclude. A rename-then-reuse resolves to exactly one account, so the
ambiguity guard never fires on it; anything uncorroborated stays on the conservative fallback, which
is strictly safer than attributing the invite to the wrong person. `SkillShareDialog`, the surface that actually
flips `isGlobalRead`/`isGlobalWrite`, reports the server's reason instead of a fixed string, so a
holder refused by the predicate this change moves can tell that apart from a network failure.

Cancelling one named recipient by email clamps `remaining` to the addresses still pending instead of
decrementing it. The two gates that let anyone holding an invite id read and redeem it treat an
invite naming nobody as a share link, and on a row minted before `isLinkOnly` existed that is
inferred from the recipient buckets - so `remaining` reaching zero is what stops a cancelled named
invite becoming a live link. A decrement only matched the address count while `remaining` started
equal to it, and `available` in the create body is taken at face value, so a row naming one person
with five slots kept four of them after that person was cancelled.

`POST /api/projects` no longer turns a typed service error into a 500. `createProject` raises
`BadRequestError` when a supplied file or notebook does not resolve through the caller's access
predicate, which the client hits whenever a pick is revoked between select and submit; the route's
catch rewrapped every non-duplicate-key error as `InternalServerError`, so that 400 reached the
client as a 500. `GET /api/[type]/[id]` now strips co-recipients' addresses from the response, the
last invitee-facing route that was returning the whole recipient list to one named recipient.

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
