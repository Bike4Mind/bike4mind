# @bike4mind/database

## 0.4.0

### Minor Changes

- [#2663](https://github.com/Bike4Mind/bike4mind/pull/2663) [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - The CASL ability's user-share arm now requires the caller's id and the requested permission to
  hold on the same `users[]` entry. The previous dotted filter (`'users.userId'` plus
  `'users.permissions'`) let Mongo satisfy the two halves from different entries, so a document
  shared with two collaborators at different levels silently promoted the weaker one: a sharee
  holding only `share` matched their own id on their entry and `read` on the other person's, and
  was granted read. This mirrors the `$elemMatch` already used on the group arm.

  Unlike the group arm, this path had no empty-collection gate in front of it, so the over-grant
  was reachable in production wherever `accessibleBy` compiles the ability into a Mongo query.
  Both ability copies are fixed together and must stay in sync: `apps/client/server/auth/ability.ts`
  and `packages/database/src/utils/ability.ts`.

- [#2663](https://github.com/Bike4Mind/bike4mind/pull/2663) [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - Second tranche of the sharing authorization cluster. A grant now means only what it says, and an
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
  inviter to hold share on the file, so the tag _is_ the authorization. That retires the previous
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

### Patch Changes

- Updated dependencies [[`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39), [`718232a`](https://github.com/Bike4Mind/bike4mind/commit/718232ac8b73f441d39cbf74041f3a06316a7248), [`c619705`](https://github.com/Bike4Mind/bike4mind/commit/c619705a92c6cbbb614b893caee446ae868beab2), [`e4263b7`](https://github.com/Bike4Mind/bike4mind/commit/e4263b73e1c24301fe4e9f6414903697bc715bfa), [`7bd1432`](https://github.com/Bike4Mind/bike4mind/commit/7bd143228cbc2b9be3434ad8d795c2ae76623241), [`b9bc64a`](https://github.com/Bike4Mind/bike4mind/commit/b9bc64a4291420be50017fb34c1dc80f92e64c89), [`d6cd7dd`](https://github.com/Bike4Mind/bike4mind/commit/d6cd7dddabe0428fee52db8fc33d045461ae4c79), [`b757a71`](https://github.com/Bike4Mind/bike4mind/commit/b757a7120009f60171e04684b4582f13bddf31b0), [`5d79949`](https://github.com/Bike4Mind/bike4mind/commit/5d7994926622a7af9d6aa38d8e547e014d3838ac), [`d6b86bf`](https://github.com/Bike4Mind/bike4mind/commit/d6b86bf0e7c644adb387d17b48e48ee6da58652c), [`d086ed5`](https://github.com/Bike4Mind/bike4mind/commit/d086ed5f0049fea32dd03034fe8f084c600b5bd7), [`b91b853`](https://github.com/Bike4Mind/bike4mind/commit/b91b853a865f8f1cf5ab417ade6fac88184886c2), [`91a73c9`](https://github.com/Bike4Mind/bike4mind/commit/91a73c9b9494408f126d267e859f9a9629e6e126), [`13e0733`](https://github.com/Bike4Mind/bike4mind/commit/13e0733c9faf196143a79225d4bcd74623f36dee), [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39)]:
  - @bike4mind/common@8.0.0
  - @bike4mind/db-core@0.6.1
  - @bike4mind/fab-pipeline@1.3.9
  - @bike4mind/utils@6.0.2
  - @bike4mind/llm-adapters@0.15.3

## 0.3.0

### Minor Changes

- [#2797](https://github.com/Bike4Mind/bike4mind/pull/2797) [`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4) Thanks [@juicewaa](https://github.com/juicewaa)! - `BaseRepository.findById` now resolves `null` for a string that is not an ObjectId instead of
  handing it to Mongoose and rejecting with a `CastError`, and it reports a row-not-found as `null`
  rather than `undefined`. The single-id lookups on `SharableDocumentModel`
  (`findAccessibleById`, `findUpdateAccessById`, `findShareAccessById`) and the `findById*`
  variants on Session, ImportHistoryJob, IdentityProvider, ResearchAgent, ResearchData and Quest
  follow the same contract.

  Wire effect: routes that hand a caller-supplied path or query id to one of these now answer the
  404 from their own `if (!doc) throw new NotFoundError(...)`. The status a caller sees for a
  malformed id is unchanged (`404`) - it previously came from the API error handler's
  `CastError path === '_id'` remapping - but it is now attributable to the route rather than to a
  middleware rule that cannot tell a caller's junk id from a server-side cast. A caller narrowing
  a miss with `=== undefined` instead of a falsy check will stop matching.

  Two list routes do change their answer, for the better: `mementos` and `organizations/stats` build
  an `_id: { $in: [...] }` from caller-supplied ids, where a single uncastable entry rejected the
  whole query and surfaced as a `404` for the entire list. They now drop the unusable entries and
  return the valid rows (`200`). An all-invalid list emits `$in: []`, so nothing widens to
  "everything", and each route keeps its own ownership filter.

  Not changed: `BaseRepository.update` and `delete` still address the row with `convertId`, which
  calls `new Types.ObjectId(id)` and throws a `BSONError` - not a `CastError`, so the error
  handler's cast remap never applied to them and they answer `500` for a malformed id both before
  and after this change. Converging them needs its own decision about what an unaddressable id
  should mean on a write (a no-op result, or a thrown not-found), so it is deliberately out of
  scope here rather than overlooked.

### Patch Changes

- Updated dependencies [[`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4), [`40f31bd`](https://github.com/Bike4Mind/bike4mind/commit/40f31bd9c9f63e6a2db9d5569222145c84fa46a0), [`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4)]:
  - @bike4mind/db-core@0.6.0
  - @bike4mind/common@7.5.0
  - @bike4mind/fab-pipeline@1.3.8
  - @bike4mind/llm-adapters@0.15.2
  - @bike4mind/utils@6.0.1

## 0.2.7

### Patch Changes

- Updated dependencies [[`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91), [`7a214d5`](https://github.com/Bike4Mind/bike4mind/commit/7a214d5aa0fb5aa65302f887a3fac356ab3dc8ca), [`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91), [`6f662d8`](https://github.com/Bike4Mind/bike4mind/commit/6f662d81308d53bb430665ed048607da97c4e9ef), [`46ea8e1`](https://github.com/Bike4Mind/bike4mind/commit/46ea8e1efc42e992ebc0a19c4542f65d2665832c), [`2cfe44d`](https://github.com/Bike4Mind/bike4mind/commit/2cfe44d452803f4be8d6689edfb4ad250b0c881c), [`068e14f`](https://github.com/Bike4Mind/bike4mind/commit/068e14f2ab9e45cb7e7cecbae8a49fca1ce85dc6), [`fa08028`](https://github.com/Bike4Mind/bike4mind/commit/fa08028c91136b4f051a45bc4976a7714677f845), [`0a4253e`](https://github.com/Bike4Mind/bike4mind/commit/0a4253e4f31492b6fea19976a469ffd5e79f4af9), [`6ce4b99`](https://github.com/Bike4Mind/bike4mind/commit/6ce4b99b9ab5d4fe8142647a9b3dcef6f0c8ebfd)]:
  - @bike4mind/utils@6.0.0
  - @bike4mind/common@7.4.0
  - @bike4mind/fab-pipeline@1.3.7
  - @bike4mind/llm-adapters@0.15.1
  - @bike4mind/db-core@0.5.7

## 0.2.6

### Patch Changes

- Updated dependencies [[`5e1eee0`](https://github.com/Bike4Mind/bike4mind/commit/5e1eee08f765b93a1c30160c03858e7c5e9fd798), [`fee546f`](https://github.com/Bike4Mind/bike4mind/commit/fee546f162297fbd3cf5acdb41b71906bdabab46), [`a4e980d`](https://github.com/Bike4Mind/bike4mind/commit/a4e980d956c721aa734dde981420adcb4bfaa243), [`2922d00`](https://github.com/Bike4Mind/bike4mind/commit/2922d0061d5ee3673da2a3b9bd88f11b7005e5db), [`afba631`](https://github.com/Bike4Mind/bike4mind/commit/afba6315105929e9b39672a2d0d23caad7f8e4aa)]:
  - @bike4mind/common@7.3.0
  - @bike4mind/llm-adapters@0.15.0
  - @bike4mind/utils@5.2.0
  - @bike4mind/fab-pipeline@1.3.6
  - @bike4mind/db-core@0.5.6

## 0.2.5

### Patch Changes

- Updated dependencies [[`2298140`](https://github.com/Bike4Mind/bike4mind/commit/229814036a13097cae1cd3ccc19d052d4d6c17f9)]:
  - @bike4mind/common@7.2.2
  - @bike4mind/db-core@0.5.5
  - @bike4mind/fab-pipeline@1.3.5
  - @bike4mind/llm-adapters@0.14.2
  - @bike4mind/utils@5.1.2

## 0.2.4

### Patch Changes

- Updated dependencies [[`8ef2c17`](https://github.com/Bike4Mind/bike4mind/commit/8ef2c17f7b54b0df8c3809f17a62544784e65029)]:
  - @bike4mind/common@7.2.1
  - @bike4mind/db-core@0.5.4
  - @bike4mind/fab-pipeline@1.3.4
  - @bike4mind/llm-adapters@0.14.1
  - @bike4mind/utils@5.1.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`b5c25db`](https://github.com/Bike4Mind/bike4mind/commit/b5c25db2ff248dd7491f7c263ae69cd1aaf23eca), [`aedbc31`](https://github.com/Bike4Mind/bike4mind/commit/aedbc312f5c166b52e166d795c7a2c6917134964), [`f6407e2`](https://github.com/Bike4Mind/bike4mind/commit/f6407e27d91175446e28246e1234d4c0a409c694), [`a756c37`](https://github.com/Bike4Mind/bike4mind/commit/a756c379f89401a9cfefc41735df4610dd5da0ce), [`0a931d2`](https://github.com/Bike4Mind/bike4mind/commit/0a931d25ddbfc35963f82f1bb6ea26b89a10f39e), [`671c753`](https://github.com/Bike4Mind/bike4mind/commit/671c753fc81d65561729f591bc7038e4c605126c), [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef), [`b660460`](https://github.com/Bike4Mind/bike4mind/commit/b6604604904ae62ab4c6745ec4e2335e05706e68), [`36fae3b`](https://github.com/Bike4Mind/bike4mind/commit/36fae3b0e2a448442c65b83735de0406ed233370)]:
  - @bike4mind/common@7.2.0
  - @bike4mind/llm-adapters@0.14.0
  - @bike4mind/fab-pipeline@1.3.3
  - @bike4mind/utils@5.1.0
  - @bike4mind/resource@0.7.0
  - @bike4mind/db-core@0.5.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`7958ee1`](https://github.com/Bike4Mind/bike4mind/commit/7958ee13d277295ed9877a24686aa266265a727f), [`0e11dab`](https://github.com/Bike4Mind/bike4mind/commit/0e11dab88d9141c364c2f9192681fd94023050d3)]:
  - @bike4mind/common@7.1.1
  - @bike4mind/llm-adapters@0.13.0
  - @bike4mind/db-core@0.5.2
  - @bike4mind/fab-pipeline@1.3.2
  - @bike4mind/utils@5.0.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`576f59f`](https://github.com/Bike4Mind/bike4mind/commit/576f59f9cb237c473c2793e72cd33e1648f12327)]:
  - @bike4mind/common@7.1.0
  - @bike4mind/db-core@0.5.1
  - @bike4mind/fab-pipeline@1.3.1
  - @bike4mind/llm-adapters@0.12.2
  - @bike4mind/utils@5.0.1

## 0.2.0

### Minor Changes

- [#2459](https://github.com/Bike4Mind/bike4mind/pull/2459) [`872164a`](https://github.com/Bike4Mind/bike4mind/commit/872164aef40a5fc24673a0c0a6ced35c97be36e2) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - Content mutations now resolve through the update-level share predicate rather than the read-level
  one, so a `read` grant on a notebook, file or project authorizes viewing it and nothing more.
  Affected paths: `updateFabFile` and `toggleTags` (file bytes, metadata and tags),
  `addSystemPrompts`, `addFiles` and `removeSystemPrompts` (project content), the chat-completion
  entry point (which appends to the notebook it runs against), and
  `PUT /api/sessions/[id]/chat/[messageId]`. A sharee who previously edited shared content while
  holding only `read` now needs `update`; project-derived grants already carry `[read, update]` and
  are unaffected.

  `IShareableStaticMethods` gains a required `findAllUpdateAccessByIds`, the batch counterpart to
  `findUpdateAccessById`, implemented by `ShareableDocumentRepository` - an out-of-tree implementer
  of that interface must add it. `@bike4mind/common` also exports `canUpdateShareable`, an
  update-level predicate for the call sites that already hold the document and so cannot re-resolve
  it through the repository.

  `DELETE /api/files` no longer hard-deletes files owned by other users that happen to be shared in
  with a delete grant: those lose the caller's grant instead, and only the caller's own files (and
  their stored bytes) are destroyed.

### Patch Changes

- Updated dependencies [[`49f96c3`](https://github.com/Bike4Mind/bike4mind/commit/49f96c3ca5303a29ac6acb318d6178a7ec7efa48), [`920a061`](https://github.com/Bike4Mind/bike4mind/commit/920a061ec7c079a86b8e4b8a2627b631af8e8fef), [`51b306b`](https://github.com/Bike4Mind/bike4mind/commit/51b306b8b5c12062e54bd586f51a80c35e581f99), [`1bdf739`](https://github.com/Bike4Mind/bike4mind/commit/1bdf7391cc8f83d42b2b00ecab7b528e5a3c0d09), [`ddd4e75`](https://github.com/Bike4Mind/bike4mind/commit/ddd4e7592d99876c8910f02afdc8d1782878f55f), [`c5c6cc6`](https://github.com/Bike4Mind/bike4mind/commit/c5c6cc6d007bfe49f6c335ebc1c18fa8272ad64b), [`787c867`](https://github.com/Bike4Mind/bike4mind/commit/787c867b9445547e05a4ab32c69cd58716aa3c53), [`116346b`](https://github.com/Bike4Mind/bike4mind/commit/116346b680d797c539e5112086aae7ed91f36273), [`70ec2a6`](https://github.com/Bike4Mind/bike4mind/commit/70ec2a68decf31e67edc8d354115b0ef7299730f), [`214d076`](https://github.com/Bike4Mind/bike4mind/commit/214d076194b7b5792af4011b29a9d071c7b7a35e), [`f2f9b3d`](https://github.com/Bike4Mind/bike4mind/commit/f2f9b3d6ae4dc69aa763b15bfc5af3f8e7ada12c), [`a467b99`](https://github.com/Bike4Mind/bike4mind/commit/a467b99c43e695a3c1657a08ddd874da4e2438ca), [`1c39465`](https://github.com/Bike4Mind/bike4mind/commit/1c394654b3ace280b8b0941742d09fbb01a236a8), [`95d158a`](https://github.com/Bike4Mind/bike4mind/commit/95d158a96782d16dceb7e56e9984ed7ab7bb5cd9), [`b6bcd64`](https://github.com/Bike4Mind/bike4mind/commit/b6bcd64d712d5231937518f329194d6504b4d3df), [`9c5588c`](https://github.com/Bike4Mind/bike4mind/commit/9c5588c25e8025755ebe0eab77c4af208ef27538), [`469c391`](https://github.com/Bike4Mind/bike4mind/commit/469c391f0e9d48ba9285210f00f597bdafb26810), [`545e51b`](https://github.com/Bike4Mind/bike4mind/commit/545e51b5a17c439ba7bd303bd4033fe0b8d4cd37), [`d6cf4b1`](https://github.com/Bike4Mind/bike4mind/commit/d6cf4b1e7a6bb09d05f3cbf041a0b1d158bb3e2b), [`c17fbcc`](https://github.com/Bike4Mind/bike4mind/commit/c17fbccb067921f8ab1b9b352eda91285bbd9720), [`1d65698`](https://github.com/Bike4Mind/bike4mind/commit/1d656985af6f8c2b3b2a486d932feca5e541a9cd), [`2351bad`](https://github.com/Bike4Mind/bike4mind/commit/2351bad305a9ea7a249669078792d970f40e73a6), [`e465103`](https://github.com/Bike4Mind/bike4mind/commit/e465103247d17e39750edc7bc9a7dddee249db7e), [`55fb6c3`](https://github.com/Bike4Mind/bike4mind/commit/55fb6c39ffc7e881293dc715594770f43c865e1a), [`354f3c6`](https://github.com/Bike4Mind/bike4mind/commit/354f3c65b4a9e84401801e3e868f217c7454cd3f), [`ad5801f`](https://github.com/Bike4Mind/bike4mind/commit/ad5801f5d44cfd198e424af10c9780aff3c04643), [`7703e89`](https://github.com/Bike4Mind/bike4mind/commit/7703e8901332dc54d0533f0784dbfbb21df7772d), [`68cfd6b`](https://github.com/Bike4Mind/bike4mind/commit/68cfd6b0458c9c45a387cd24ab46399ed5afbca9), [`c7ac7d2`](https://github.com/Bike4Mind/bike4mind/commit/c7ac7d2d76150ef30c20e692d0445c4518575b1d), [`3ac67a8`](https://github.com/Bike4Mind/bike4mind/commit/3ac67a8ef1540c89b885458d2dedb4be77a3d752), [`4af59ad`](https://github.com/Bike4Mind/bike4mind/commit/4af59adbd76c4de00d78db6c8f3d2ed9eeea7085), [`72430db`](https://github.com/Bike4Mind/bike4mind/commit/72430db9a825facba11528fbd04ad620d91761f7), [`f191816`](https://github.com/Bike4Mind/bike4mind/commit/f19181619bceed9c225ca4586305fb219cdb2589), [`ed62ab7`](https://github.com/Bike4Mind/bike4mind/commit/ed62ab7149c9af24b36e772a5bbf934d512674b7), [`8fd5c09`](https://github.com/Bike4Mind/bike4mind/commit/8fd5c09dc29ac2b516552a1d289d5113631520d0), [`f712bb8`](https://github.com/Bike4Mind/bike4mind/commit/f712bb827c37af41c43d26ef9e5b4c607ee7f056), [`1cd2b7d`](https://github.com/Bike4Mind/bike4mind/commit/1cd2b7d520bd9150e54c3f8a3df2f1bc2b51afcd), [`9b317ab`](https://github.com/Bike4Mind/bike4mind/commit/9b317ab5825776b433e69a1d8f255a12e8be625b), [`fbc0c09`](https://github.com/Bike4Mind/bike4mind/commit/fbc0c0959bf597d4dc253d5ef1bdf1f7f2b2723b), [`32f72a1`](https://github.com/Bike4Mind/bike4mind/commit/32f72a160b0bb5827dd9a458ea16a6adb7abae39), [`201bf43`](https://github.com/Bike4Mind/bike4mind/commit/201bf436ba987b47c363ebc7a6c7b4ece8801860), [`b0b13bf`](https://github.com/Bike4Mind/bike4mind/commit/b0b13bf82601945d456dd0bf59b3aecf19eed137), [`ea49d82`](https://github.com/Bike4Mind/bike4mind/commit/ea49d82a08e85ff27a43699b7ecdd85a526857c5), [`8c183d3`](https://github.com/Bike4Mind/bike4mind/commit/8c183d3f6b7ce48eaf1e8bfe61e82e18332cf9b2), [`cc0e8e3`](https://github.com/Bike4Mind/bike4mind/commit/cc0e8e3ae147c45f375e8ddecea5503e97fb78e7), [`e285e73`](https://github.com/Bike4Mind/bike4mind/commit/e285e738ff13227869492811f1a10865d6d82f03), [`be2fd04`](https://github.com/Bike4Mind/bike4mind/commit/be2fd04c6fd9d591ed48a46e62df95da3d0c1816), [`67efe74`](https://github.com/Bike4Mind/bike4mind/commit/67efe744faaf9289b62ac70b31cbe002426b0ee8), [`42c04cc`](https://github.com/Bike4Mind/bike4mind/commit/42c04cc38d47b51d9579c3d7dced5df42cd1b7f8), [`b8c6d29`](https://github.com/Bike4Mind/bike4mind/commit/b8c6d290a814bdf7e9cc04eb2c90c970d53976df), [`f4cce81`](https://github.com/Bike4Mind/bike4mind/commit/f4cce81c67e29b74f6ba7f9775438e3799fd92b0), [`cb227a3`](https://github.com/Bike4Mind/bike4mind/commit/cb227a3ad54ecfd5647ff92f4ebf68e3a4651c99), [`e79c63d`](https://github.com/Bike4Mind/bike4mind/commit/e79c63dc24c06e36e690282c2190e944a67b00f1), [`466e5a9`](https://github.com/Bike4Mind/bike4mind/commit/466e5a9b2ed4276f8886faec3aea42ff8484434b), [`872164a`](https://github.com/Bike4Mind/bike4mind/commit/872164aef40a5fc24673a0c0a6ced35c97be36e2), [`466e5a9`](https://github.com/Bike4Mind/bike4mind/commit/466e5a9b2ed4276f8886faec3aea42ff8484434b)]:
  - @bike4mind/common@7.0.0
  - @bike4mind/utils@5.0.0
  - @bike4mind/resource@0.6.0
  - @bike4mind/db-core@0.5.0
  - @bike4mind/llm-adapters@0.12.1
  - @bike4mind/fab-pipeline@1.3.0

## 0.1.61

### Patch Changes

- [#2121](https://github.com/Bike4Mind/bike4mind/pull/2121) [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367) Thanks [@biletskiy6](https://github.com/biletskiy6)! - bound, non-sliding recovery rotation for the auth session store

  `IAuthSessionRepository` gains a required `recoverRotateHash`, and two existing signatures tighten:
  `rotateHash`'s `newExpiresAt` is now required, and `recoverRotateHash` takes `maxRecoveries` and no
  `newExpiresAt` at all. That asymmetry is deliberate and load-bearing - only a rotation from the
  CURRENT secret earns a slide, so a superseded secret can never extend the session it is used
  against - and it is encoded in the types so a call site cannot regress it silently. Any caller
  passing the real `authSessionRepository` is unaffected; a hand-rolled minimal adapter will fail to
  compile against this patch.

  `AuthSession` also gains a `recoveries` counter (schema default `0`, absent on pre-existing rows and
  handled by the filter, so no migration is required).

- Updated dependencies [[`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`525f033`](https://github.com/Bike4Mind/bike4mind/commit/525f03368f978196a3ea434f7ee39a48e45243a2), [`37454b6`](https://github.com/Bike4Mind/bike4mind/commit/37454b686642fc0da72cb33e4be0113091489ad2), [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9), [`f5ba462`](https://github.com/Bike4Mind/bike4mind/commit/f5ba46259b065515d8ff4f053235ddc0b1c5c795), [`f1edc9c`](https://github.com/Bike4Mind/bike4mind/commit/f1edc9cce1a8c9133a45d37fb844991e3c0de076), [`595a3c4`](https://github.com/Bike4Mind/bike4mind/commit/595a3c4d054a121f3147c2be08a610ab917b1427), [`0e33727`](https://github.com/Bike4Mind/bike4mind/commit/0e33727cd5a086a9d730d35462af72e48f34ac9b), [`da0acd2`](https://github.com/Bike4Mind/bike4mind/commit/da0acd2ec1311888cf8ad2395c05f7ad38666f6e), [`3bd4ad6`](https://github.com/Bike4Mind/bike4mind/commit/3bd4ad6828ea78f7b1e6d9897ccaa7fda08e964b), [`3e7c1e9`](https://github.com/Bike4Mind/bike4mind/commit/3e7c1e9ab0becb26160db8d93e6d6af3fa5b97b5), [`c4b7962`](https://github.com/Bike4Mind/bike4mind/commit/c4b7962f5fbd52b283548cafc775ea065c5f85b0), [`a19bf36`](https://github.com/Bike4Mind/bike4mind/commit/a19bf362a74750595cd23302fbab2fd4a5bc86d8), [`fd148e9`](https://github.com/Bike4Mind/bike4mind/commit/fd148e9746eec8a4bcf7754f0154b6905c9d6f07), [`95c7198`](https://github.com/Bike4Mind/bike4mind/commit/95c7198d085d3e10411605fe267975da44fd1bcd), [`d1c8650`](https://github.com/Bike4Mind/bike4mind/commit/d1c8650647bb49ad2b22310310fae75e6550391c), [`8bfaf05`](https://github.com/Bike4Mind/bike4mind/commit/8bfaf056e6ab009116ac5563c9ac8d1f417aaaa4), [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720), [`cdf7dc9`](https://github.com/Bike4Mind/bike4mind/commit/cdf7dc927716e0034811ac6c4075b0a6de481f1f), [`3e60eac`](https://github.com/Bike4Mind/bike4mind/commit/3e60eac7a5c1929aaebde34ef1c40c3eb1c3d9fc), [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12), [`eb230ef`](https://github.com/Bike4Mind/bike4mind/commit/eb230ef2a0d2bf5ebde4e950001bf0f7a571d4d3), [`bf8b6c1`](https://github.com/Bike4Mind/bike4mind/commit/bf8b6c1133763432bac2443d7724403a2ac84f80), [`2aa3254`](https://github.com/Bike4Mind/bike4mind/commit/2aa32546e79f795cb51af3afe7254af1b925060c), [`376856f`](https://github.com/Bike4Mind/bike4mind/commit/376856fa2433e0333c4e31c01b09a3ccc9917729), [`d9bc5f0`](https://github.com/Bike4Mind/bike4mind/commit/d9bc5f0d08e261177ecac2c1e70da801d80e2386), [`fdcf36a`](https://github.com/Bike4Mind/bike4mind/commit/fdcf36ae431604a775e689db8ca7f5d72b8804ba), [`4fda73d`](https://github.com/Bike4Mind/bike4mind/commit/4fda73dffcd208127a2cdf258469ff5ce8654ad4), [`8da0adc`](https://github.com/Bike4Mind/bike4mind/commit/8da0adcb9e74a7afd6ed7633f66691330c6fad44), [`ec0a7a9`](https://github.com/Bike4Mind/bike4mind/commit/ec0a7a99ff43dabd963597ebd940bcf21b866966), [`c115fec`](https://github.com/Bike4Mind/bike4mind/commit/c115fec6c74f414940cd9597c3168fafefe3e8b0), [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d), [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425), [`2180d34`](https://github.com/Bike4Mind/bike4mind/commit/2180d347c173445b5d01a5b4862292e71c16b21a), [`6265d9a`](https://github.com/Bike4Mind/bike4mind/commit/6265d9a82abd90580b554e707866a9330ebca75a), [`a7dac96`](https://github.com/Bike4Mind/bike4mind/commit/a7dac96d93e989399e0675df482a43fdfbdce7b5), [`61aa2be`](https://github.com/Bike4Mind/bike4mind/commit/61aa2bedbea473630009bf3cb817233d09bc3d8e), [`aee1ae9`](https://github.com/Bike4Mind/bike4mind/commit/aee1ae92e282fd948ebaa9c0155dc915a4014d7c), [`8f530a3`](https://github.com/Bike4Mind/bike4mind/commit/8f530a32d6b20d0c5fb93841b80f3b6a499e6c27), [`79e9515`](https://github.com/Bike4Mind/bike4mind/commit/79e9515a622c9176551d8285e958d07560185803), [`914da78`](https://github.com/Bike4Mind/bike4mind/commit/914da7856b153c94e3c308e1c290cda7ec25d2fe), [`7ceea1e`](https://github.com/Bike4Mind/bike4mind/commit/7ceea1e54bfdc3259d8068134f2ddbafd56a262a), [`1a19d8f`](https://github.com/Bike4Mind/bike4mind/commit/1a19d8f089fbe9075c6129abe6954bb693258374), [`da1b102`](https://github.com/Bike4Mind/bike4mind/commit/da1b102bf15adf7bd960d8d104b98d822d7151a1), [`12e6b6a`](https://github.com/Bike4Mind/bike4mind/commit/12e6b6a42e19b78176d67d75bdec1d9f195e1c44), [`461fcd7`](https://github.com/Bike4Mind/bike4mind/commit/461fcd7ed0bcf1c4089329ba055915caf9f66e5e), [`a4fcb93`](https://github.com/Bike4Mind/bike4mind/commit/a4fcb93eeae40df65f14bf17910a00c9f57e8437), [`4c7122b`](https://github.com/Bike4Mind/bike4mind/commit/4c7122bbbc5e3c03e73b2c4cac9c8b45579df7dc), [`c97f73d`](https://github.com/Bike4Mind/bike4mind/commit/c97f73d5a6f2231ac8e581f1789f43af9e69b9c7), [`b255a0d`](https://github.com/Bike4Mind/bike4mind/commit/b255a0d03cc04b417355fe6cf33d66863f134662), [`08cf107`](https://github.com/Bike4Mind/bike4mind/commit/08cf1075eb2834b155adf461f2e03ed2e37e6a11), [`c3e5ab6`](https://github.com/Bike4Mind/bike4mind/commit/c3e5ab69e2e30bde319565b847acc24aa00387df), [`d775d5c`](https://github.com/Bike4Mind/bike4mind/commit/d775d5c3308bb443b15ea62547d6ff0d5cddfbe8), [`1445c44`](https://github.com/Bike4Mind/bike4mind/commit/1445c44b596f24f86f5f33bbf590e6d11210759d), [`d575bb0`](https://github.com/Bike4Mind/bike4mind/commit/d575bb0a5b90fa1729f2b4fb8a060d14ff34746b), [`8f68920`](https://github.com/Bike4Mind/bike4mind/commit/8f68920798c2e5617368531d43d6ea80c8855fe9), [`3d788bd`](https://github.com/Bike4Mind/bike4mind/commit/3d788bd9365c3e7dc2b344e20e32ac6153ad2beb), [`644ae9e`](https://github.com/Bike4Mind/bike4mind/commit/644ae9e289640b3f4e56f9eb6e3a9e7ad5d2d72e), [`36c26fd`](https://github.com/Bike4Mind/bike4mind/commit/36c26fd1bb6b3a08072032738c25b301b166a5e8), [`fe42856`](https://github.com/Bike4Mind/bike4mind/commit/fe4285649365d4494bbfa4ba8ea56030373cdb74), [`f79d864`](https://github.com/Bike4Mind/bike4mind/commit/f79d8641c802e50ec0f5f6e9e74b5ce7ab24444a), [`75cf435`](https://github.com/Bike4Mind/bike4mind/commit/75cf4359a3ac18de8c7a6dae4dbace495b4d8bef), [`e55790f`](https://github.com/Bike4Mind/bike4mind/commit/e55790f6daa2281cc45a786821221b81c0893d4b), [`cefb930`](https://github.com/Bike4Mind/bike4mind/commit/cefb930d19a48c800d8199071284b16dd8907e21), [`0b24f62`](https://github.com/Bike4Mind/bike4mind/commit/0b24f6272a8a56b06e2df321b848a26a95333a9f), [`9158cf0`](https://github.com/Bike4Mind/bike4mind/commit/9158cf086acd1b9d7863a9ea76b932280d4460ac), [`323718c`](https://github.com/Bike4Mind/bike4mind/commit/323718c8691d506cbe26cd74f7cfd4a73e28ff61), [`1901bb2`](https://github.com/Bike4Mind/bike4mind/commit/1901bb2489b4b0c797d501ff2848f3658077c84a), [`83a6254`](https://github.com/Bike4Mind/bike4mind/commit/83a625434a791a0bbbbcd38ddb93d3a20db23160), [`dbcf733`](https://github.com/Bike4Mind/bike4mind/commit/dbcf733569d659bb818818f11d8298ec3062a0f1), [`2068806`](https://github.com/Bike4Mind/bike4mind/commit/206880678ce77b39c4782b94d63715bdea4d35c6), [`6185bb1`](https://github.com/Bike4Mind/bike4mind/commit/6185bb10f611fc32dc06b88941c81799027ced75), [`6d3390e`](https://github.com/Bike4Mind/bike4mind/commit/6d3390e0989a0acfd1dcbe8b26f6ed3bb3db3bb6), [`5da4b0a`](https://github.com/Bike4Mind/bike4mind/commit/5da4b0a44a12b48745c4bef70ae9ac65b6cf640b), [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`dde7b36`](https://github.com/Bike4Mind/bike4mind/commit/dde7b365998accc4f97ff0475df46d00b477e019), [`4981f5a`](https://github.com/Bike4Mind/bike4mind/commit/4981f5a0ffd69e716a1d3879aac99ede78a3cfef), [`deb6ddf`](https://github.com/Bike4Mind/bike4mind/commit/deb6ddfe8d8083a8bcca715cbc730d778a3fe43b), [`9e29782`](https://github.com/Bike4Mind/bike4mind/commit/9e2978286aaa5c6b1e2a08c9744a98f0ff62ee4b), [`63d0783`](https://github.com/Bike4Mind/bike4mind/commit/63d0783fb8120b7d4249aec0348986c0ee4e33f4)]:
  - @bike4mind/common@6.0.0
  - @bike4mind/fab-pipeline@1.2.0
  - @bike4mind/llm-adapters@0.12.0
  - @bike4mind/utils@4.2.0
  - @bike4mind/db-core@0.4.1

## 0.1.60

### Patch Changes

- Updated dependencies [[`3a3aef0`](https://github.com/Bike4Mind/bike4mind/commit/3a3aef0b59afe349f2f5e78ff3c693ea98f616e7), [`da0f7ab`](https://github.com/Bike4Mind/bike4mind/commit/da0f7abd8decb98b13cb3c006a2a4f21e294a974), [`c7b5854`](https://github.com/Bike4Mind/bike4mind/commit/c7b5854b3a02afdcd4d8c480d93f1005d5ee47c6), [`8e03a0e`](https://github.com/Bike4Mind/bike4mind/commit/8e03a0ed6430e40280db316e2301a0f20a8ddc57), [`c9f2085`](https://github.com/Bike4Mind/bike4mind/commit/c9f208569698a2a1ec8210923493d1c460cefbca), [`0b4e580`](https://github.com/Bike4Mind/bike4mind/commit/0b4e58050f10e92ec4f6fad32017d28c54a9d0ae), [`9fad658`](https://github.com/Bike4Mind/bike4mind/commit/9fad658b6504fa00b85045b028aa23c8d27d7bb2), [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2), [`9fc991e`](https://github.com/Bike4Mind/bike4mind/commit/9fc991e214af4fd2b1442759dc37528e74b33f11), [`de702ea`](https://github.com/Bike4Mind/bike4mind/commit/de702ea4ada1f91ad26167f2d7899a336cf647da), [`50b52a5`](https://github.com/Bike4Mind/bike4mind/commit/50b52a5fb5f3344b56bd4644b3a2154ca51fe31e), [`cb58a53`](https://github.com/Bike4Mind/bike4mind/commit/cb58a5394c377c8250ff7dafa0a251652be2a87a), [`7c8240c`](https://github.com/Bike4Mind/bike4mind/commit/7c8240ce7aa7ab839ad3ac7cc42aa51bc4fa9055), [`c46c8a4`](https://github.com/Bike4Mind/bike4mind/commit/c46c8a46e33df208d4547be6cd07b79add171ef2), [`e805cbe`](https://github.com/Bike4Mind/bike4mind/commit/e805cbe54ebd5c7d1113769d9e28875b79a71fe9), [`1507c14`](https://github.com/Bike4Mind/bike4mind/commit/1507c143605a375cce15735d4a953c3ee470bc7d)]:
  - @bike4mind/common@5.0.0
  - @bike4mind/utils@4.1.0
  - @bike4mind/hearth@0.3.0
  - @bike4mind/fab-pipeline@1.1.0
  - @bike4mind/db-core@0.4.0
  - @bike4mind/llm-adapters@0.11.2

## 0.1.59

### Patch Changes

- Updated dependencies [[`abc90f5`](https://github.com/Bike4Mind/bike4mind/commit/abc90f562e15caa46428fc94afa3ffff410e5d5c), [`851e2c2`](https://github.com/Bike4Mind/bike4mind/commit/851e2c26928c92c574d9310e2eec8e268f672882), [`ed20c15`](https://github.com/Bike4Mind/bike4mind/commit/ed20c1595a1a3bdfcd2b67302b1a0d05a713e826)]:
  - @bike4mind/common@4.0.1
  - @bike4mind/utils@4.0.0
  - @bike4mind/db-core@0.3.1
  - @bike4mind/fab-pipeline@1.0.1
  - @bike4mind/llm-adapters@0.11.1

## 0.1.58

### Patch Changes

- Updated dependencies [[`c09e844`](https://github.com/Bike4Mind/bike4mind/commit/c09e84486c087c8a108b802cf5d9d1b63ea5fa91), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9), [`ad5921f`](https://github.com/Bike4Mind/bike4mind/commit/ad5921f531fdd2db2fa4a2a783ebde60f2566034), [`847c3a3`](https://github.com/Bike4Mind/bike4mind/commit/847c3a359ec1ee8d6374dd3819de8f8bb6ea269d), [`6d01a12`](https://github.com/Bike4Mind/bike4mind/commit/6d01a124b85c54ac76d532773a44d42091ed7b83), [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5), [`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989), [`7649b72`](https://github.com/Bike4Mind/bike4mind/commit/7649b72711987dc50e07b21cb0659c4b32f56221), [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62), [`55cc590`](https://github.com/Bike4Mind/bike4mind/commit/55cc5901ca051b8b5d9c4de02a42c5828b18adfe), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3), [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592), [`42b0798`](https://github.com/Bike4Mind/bike4mind/commit/42b0798e751b28190fb2757fa37d5ab345e08eae), [`1e3699a`](https://github.com/Bike4Mind/bike4mind/commit/1e3699a72f4d87b6ab0465fd401901544c3fed76), [`67c107a`](https://github.com/Bike4Mind/bike4mind/commit/67c107ae7e40c9f5b30875853bb12a4c016c7437), [`671bad8`](https://github.com/Bike4Mind/bike4mind/commit/671bad887ead27267709978ad340fb1bce3d2f6f), [`9b746b6`](https://github.com/Bike4Mind/bike4mind/commit/9b746b6c560ac2feb66193075c929c71953ec3d6), [`05c9e5c`](https://github.com/Bike4Mind/bike4mind/commit/05c9e5cd4393667099f0bc324599311b5eff3d6a), [`5990451`](https://github.com/Bike4Mind/bike4mind/commit/5990451279e3ee9058615051711a6e243218a587), [`d9d28d3`](https://github.com/Bike4Mind/bike4mind/commit/d9d28d3d89097ee33782dd2d631e77fd2db0f381), [`120b37c`](https://github.com/Bike4Mind/bike4mind/commit/120b37c7a6abf5be317062dae10c3996a97d76e8), [`a25e9ff`](https://github.com/Bike4Mind/bike4mind/commit/a25e9ff98a714cbca6980a8902e309bb6263de5e), [`04f4964`](https://github.com/Bike4Mind/bike4mind/commit/04f4964b1630bdf1e5cd178d7d6bff1bc28adb58), [`8a899b2`](https://github.com/Bike4Mind/bike4mind/commit/8a899b26677a9fab54b5652ba9c06f429b2a5abe), [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b), [`25bc463`](https://github.com/Bike4Mind/bike4mind/commit/25bc46318510bc2631d86692995c1335397d62a6), [`ccd97cd`](https://github.com/Bike4Mind/bike4mind/commit/ccd97cda43b3344ca99b5a8fa81f7819ff701ade), [`42b99f8`](https://github.com/Bike4Mind/bike4mind/commit/42b99f8a22137a01c951a60ab67cef7273e9f43b), [`87425da`](https://github.com/Bike4Mind/bike4mind/commit/87425dafa8b98d5bae718dd52763483b24aee1b5), [`dd5355f`](https://github.com/Bike4Mind/bike4mind/commit/dd5355f5c98d23fc93a603dc9a24a5da18226b16), [`cdd3a09`](https://github.com/Bike4Mind/bike4mind/commit/cdd3a09854f08fee25a71a53b42b76fb64a33c7d), [`6e84c0d`](https://github.com/Bike4Mind/bike4mind/commit/6e84c0d760ca11a1175f9a8042c53eab4276a0b6), [`a8d15d3`](https://github.com/Bike4Mind/bike4mind/commit/a8d15d3aa4f3a8a6dbc309731db1aa5dd49ef4ba), [`59088ab`](https://github.com/Bike4Mind/bike4mind/commit/59088ab8f1cd217d12110770041bb43c79840142), [`aa928d4`](https://github.com/Bike4Mind/bike4mind/commit/aa928d4401d809818ac981957ffed385d98115dd), [`c6b9eb1`](https://github.com/Bike4Mind/bike4mind/commit/c6b9eb1c0e62077e43e57ff6c78d7263c3e56dad), [`dc52359`](https://github.com/Bike4Mind/bike4mind/commit/dc5235923732a525f1b9dac2846426bb64a227ba), [`4845a87`](https://github.com/Bike4Mind/bike4mind/commit/4845a87b855e9016e52c4a9514008a22edb5260e), [`cc97fe6`](https://github.com/Bike4Mind/bike4mind/commit/cc97fe6a79940598e7f1700dc38113d597d7ebb1), [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb), [`fc5bfd8`](https://github.com/Bike4Mind/bike4mind/commit/fc5bfd8c3e5b14453c7d79ecfe589537b9f5eec6), [`90717f8`](https://github.com/Bike4Mind/bike4mind/commit/90717f8a4c080738fe2ce0bddadd4fc02b6361c4), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`1d26e34`](https://github.com/Bike4Mind/bike4mind/commit/1d26e34a64bc0e1497acf37bee3dc35d61a7f3cc), [`bf8548e`](https://github.com/Bike4Mind/bike4mind/commit/bf8548e646a33e97afc2ed229cbb676c7c6033ab), [`76d7e98`](https://github.com/Bike4Mind/bike4mind/commit/76d7e988422ddd811cd57d2c797f91dd95a729dc), [`95fbfa4`](https://github.com/Bike4Mind/bike4mind/commit/95fbfa4d70eb2e24a8981544d174a41583994fa8), [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9), [`5ff3797`](https://github.com/Bike4Mind/bike4mind/commit/5ff3797b6b83ec20629efb24c5216288a90a84f8), [`c632544`](https://github.com/Bike4Mind/bike4mind/commit/c632544d07271bb44d124fd3dfeb9876fc6dc536), [`89f72cb`](https://github.com/Bike4Mind/bike4mind/commit/89f72cbdd9e7e93d59c01c51f7c55fe0396283c6), [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948), [`cf2c553`](https://github.com/Bike4Mind/bike4mind/commit/cf2c5531ca947f6c3be6ffd6175ea94f0cc390c1), [`a08949c`](https://github.com/Bike4Mind/bike4mind/commit/a08949cb625d2d3d6f7bc2c86f3828eb20d483e4), [`fab1452`](https://github.com/Bike4Mind/bike4mind/commit/fab1452922c8564495fb9209b346c1b91f0c7aa2), [`cc085b0`](https://github.com/Bike4Mind/bike4mind/commit/cc085b047884f1733b6c84958da4400da1712cd4), [`758f406`](https://github.com/Bike4Mind/bike4mind/commit/758f406376efa5ef605f79b65f576d97854c7689), [`2a3162b`](https://github.com/Bike4Mind/bike4mind/commit/2a3162b2db07090b7fd74fb1ac628bcb2f421cf0), [`ebed878`](https://github.com/Bike4Mind/bike4mind/commit/ebed87812a188eda01788349489e33956f1de44a), [`19abb8c`](https://github.com/Bike4Mind/bike4mind/commit/19abb8c2662979fc4d0648dabfa7364ca6cdb81e), [`40a35ea`](https://github.com/Bike4Mind/bike4mind/commit/40a35ea7f4c530fdbcbc99cf9bee771762b2da96), [`b69313e`](https://github.com/Bike4Mind/bike4mind/commit/b69313ec9147a1da341e0c32f26d6af499c09fea), [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02), [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3), [`4dffc64`](https://github.com/Bike4Mind/bike4mind/commit/4dffc64de320f4a59257febe89b1124fbe96e536), [`d4c3719`](https://github.com/Bike4Mind/bike4mind/commit/d4c3719a98b76093127057d7e7d5a265eebcc810), [`f29a8ef`](https://github.com/Bike4Mind/bike4mind/commit/f29a8eff394568438a6126610b557f3985dc1c93), [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf), [`27096e3`](https://github.com/Bike4Mind/bike4mind/commit/27096e3d34e80a23fa40a0c9060498d3cdf27bf4), [`96dd741`](https://github.com/Bike4Mind/bike4mind/commit/96dd7415e5465cc1c0318ccfe0d64c9478411024), [`36b0c67`](https://github.com/Bike4Mind/bike4mind/commit/36b0c67c39b9b8b1645572202255685e2ca770e1), [`7b452e9`](https://github.com/Bike4Mind/bike4mind/commit/7b452e92621fe836eec4acf1c2bd6dff06a8f95e), [`4585043`](https://github.com/Bike4Mind/bike4mind/commit/4585043f39f4e57e052047239834fa281dc34141), [`26257f4`](https://github.com/Bike4Mind/bike4mind/commit/26257f4992c219acd095b209a48bf914b4ccff0a), [`db1655c`](https://github.com/Bike4Mind/bike4mind/commit/db1655c7072131f55b3dbdeb5a212768786fe9ef), [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4), [`7901ec1`](https://github.com/Bike4Mind/bike4mind/commit/7901ec1e668fe2a55e1e128d2c2c5b26dcca5e12), [`43b8c8d`](https://github.com/Bike4Mind/bike4mind/commit/43b8c8d65e1743f81eedad36fa4c32d3e4685738), [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14), [`e60f14a`](https://github.com/Bike4Mind/bike4mind/commit/e60f14aa734c6fc41a6c59ae1fd57bb9b386aa08), [`c4d2da6`](https://github.com/Bike4Mind/bike4mind/commit/c4d2da628bcba7c7a553dd4e9a26ff04ad258bb8), [`a3ca585`](https://github.com/Bike4Mind/bike4mind/commit/a3ca585906fee85628701c6975062b6f16590106), [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8), [`7b6f99b`](https://github.com/Bike4Mind/bike4mind/commit/7b6f99beb0d58e4d4382c0e8e9e90925a7f5e350), [`1332668`](https://github.com/Bike4Mind/bike4mind/commit/133266801e52d4402150e5605a994a0d8522d8fa), [`c324761`](https://github.com/Bike4Mind/bike4mind/commit/c324761fd20870fea316f5da63214e7fbb07c55d), [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d), [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6), [`c2f4cbc`](https://github.com/Bike4Mind/bike4mind/commit/c2f4cbc864b653c47c05c94e07495fa757331a51), [`6b4f36e`](https://github.com/Bike4Mind/bike4mind/commit/6b4f36edfe3ff42542357eaa1a91dca90045d4dc), [`c604eba`](https://github.com/Bike4Mind/bike4mind/commit/c604eba580c0ebea8b58e01bba0a3d424628b789), [`5d81e2c`](https://github.com/Bike4Mind/bike4mind/commit/5d81e2c64712792a7d65690e0f4755f4a19d2ff4), [`a948fb9`](https://github.com/Bike4Mind/bike4mind/commit/a948fb9ffe34d0e76de5a85bbb96c857f081bb6c), [`886d408`](https://github.com/Bike4Mind/bike4mind/commit/886d40823384c9ff06ee84ab8da20ebbac3e8d3f), [`2e2c285`](https://github.com/Bike4Mind/bike4mind/commit/2e2c28547d92487ee89ded3129970bf27692a74b), [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21), [`9d1c73b`](https://github.com/Bike4Mind/bike4mind/commit/9d1c73b1c51bd6aa1380b3c2da27fc35e9e49ae0), [`7dd0442`](https://github.com/Bike4Mind/bike4mind/commit/7dd0442f5bf54c04019da953d2187ff557ff4e0f), [`ab05d21`](https://github.com/Bike4Mind/bike4mind/commit/ab05d2112dbb61f124ff37227b40c92b667ee1d1), [`9023927`](https://github.com/Bike4Mind/bike4mind/commit/90239272090b220c0356b2b84f525316b1dcafb9), [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462), [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8), [`a392018`](https://github.com/Bike4Mind/bike4mind/commit/a3920185ffd1a31c1f1c228b24011ea4d58926bd), [`4ca1471`](https://github.com/Bike4Mind/bike4mind/commit/4ca14711bbb459fe30969c9f58358adda37631fe), [`3d7d6f6`](https://github.com/Bike4Mind/bike4mind/commit/3d7d6f6f7601375e40dc4d36f95a088137ecb58f), [`ef8492a`](https://github.com/Bike4Mind/bike4mind/commit/ef8492afbeb06ea552665841efb547448786f1a4), [`399f2c7`](https://github.com/Bike4Mind/bike4mind/commit/399f2c7c941954e0dfd5b37e010bbeaa54ea2140), [`44b63f2`](https://github.com/Bike4Mind/bike4mind/commit/44b63f28de85494f5ee71203e74670bdef1ccd04), [`1557271`](https://github.com/Bike4Mind/bike4mind/commit/15572713aeafb5eab086833ea7faedcdd8867d32), [`ee85861`](https://github.com/Bike4Mind/bike4mind/commit/ee85861d2821767d0d0648a960303ba66a19bb00), [`61025c3`](https://github.com/Bike4Mind/bike4mind/commit/61025c3651db5aa06c7acd4ce292e445f05c00ed), [`8ca1a70`](https://github.com/Bike4Mind/bike4mind/commit/8ca1a70c2b0bfbf7bccb33620cdbff83fd77cb47), [`3d37217`](https://github.com/Bike4Mind/bike4mind/commit/3d3721797e898732b5d597815c4fdfd0581de715), [`eb23f3a`](https://github.com/Bike4Mind/bike4mind/commit/eb23f3a16f66c7758e84f6e486ae3058f9e13e93), [`91cdd07`](https://github.com/Bike4Mind/bike4mind/commit/91cdd07bef6e972688f64694a06c2d4b4ab23010), [`000c0b5`](https://github.com/Bike4Mind/bike4mind/commit/000c0b515913da4a894de023937131a355aa868a), [`5d96e19`](https://github.com/Bike4Mind/bike4mind/commit/5d96e197961cd634cc7c4ae1fdcc1878500b7545), [`b960ba8`](https://github.com/Bike4Mind/bike4mind/commit/b960ba8d6229df95f787c842eb315c3331d6ba2f), [`cc63f75`](https://github.com/Bike4Mind/bike4mind/commit/cc63f75ab8119a9a2160d906c0b789626ffcd960), [`bf8dbbd`](https://github.com/Bike4Mind/bike4mind/commit/bf8dbbd8f050608d52588b32108ce098a2a5047e), [`c95fe24`](https://github.com/Bike4Mind/bike4mind/commit/c95fe2462e911310f9cbb0a7b3155dc95e1b1077), [`beca7a0`](https://github.com/Bike4Mind/bike4mind/commit/beca7a095c9266cef2dd22169a005f5b96e44ccf), [`c1f563e`](https://github.com/Bike4Mind/bike4mind/commit/c1f563ee248317485e4262289dec13c16e864dd7), [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc), [`68b36d1`](https://github.com/Bike4Mind/bike4mind/commit/68b36d1945ac9ba757f6c59b0a3e7417cb95223c), [`01ab7af`](https://github.com/Bike4Mind/bike4mind/commit/01ab7afbef983a8fe27c260c37828667122902a4), [`ec61517`](https://github.com/Bike4Mind/bike4mind/commit/ec6151734c62cb681c85866e003776040f776bed), [`0de8b32`](https://github.com/Bike4Mind/bike4mind/commit/0de8b3205b15b307b53ae45896905a29f0d9e073)]:
  - @bike4mind/llm-adapters@0.11.0
  - @bike4mind/utils@3.1.0
  - @bike4mind/common@4.0.0
  - @bike4mind/fab-pipeline@1.0.0
  - @bike4mind/hearth@0.2.0
  - @bike4mind/db-core@0.3.0

## 0.1.57

### Patch Changes

- Updated dependencies:
  - @bike4mind/common@3.0.0
  - @bike4mind/llm-adapters@0.10.0
  - @bike4mind/utils@3.0.0
  - @bike4mind/db-core@0.2.10
