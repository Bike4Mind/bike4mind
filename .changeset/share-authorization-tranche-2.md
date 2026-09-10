---
'@bike4mind/common': minor
'@bike4mind/database': minor
'@bike4mind/services': major
---

Second tranche of the sharing authorization cluster. A grant now means only what it says, and an
entity that derives grants cleans them up when it goes away.

Re-sharing is capped and gated. An invite can no longer carry a permission its minter does not
hold, so a sharee with `share` alone cannot mint `update`/`delete` and redeem the link on their own
account; `@bike4mind/common` exports `heldPermissions` for that check. Flipping `isGlobalRead`/
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
