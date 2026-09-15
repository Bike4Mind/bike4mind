import { InviteType, type IInvite } from '../types/entities/InviteType';

/** The fields the link-only predicate reads. Keeps callers free to pass a lean projection. */
export type LinkOnlyInviteShape = Pick<IInvite, 'isLinkOnly' | 'recipients' | 'type'>;

/**
 * Whether an invite names nobody BY DESIGN, i.e. a share link anyone holding the id may redeem.
 *
 * Keyed on the persisted flag, never on an empty `recipients.pending`. Project and Organization
 * invites carry raw user ids, and `UserModel.findAllByEmailsOrUsernames` queries email and
 * username only, so before createInvite resolved those by id a named invite that failed to
 * resolve was indistinguishable from a link invite - and every gate keyed on `pending.length`
 * fell open for exactly those two types.
 *
 * Rows minted before the flag existed fall back to inferring it, and only for the two types whose
 * recipients always did resolve to emails. A legacy Project/Organization invite therefore reads as
 * named-but-unresolved and fails closed at both the view and accept gates rather than open.
 *
 * The inference unions all three recipient buckets, `refused` included. Accepting and declining
 * both move an address out of `pending`, so reading only `pending` and `accepted` made an invite
 * whose named recipients had all declined infer as link-only - which opens the view gate to any
 * authenticated caller and lets anyone redeem it. A declined invite names people; it names them in
 * a different bucket.
 *
 * The union is NOT self-sufficient, and a caller must not read it as though it were. Three paths
 * empty `pending` without moving the addresses anywhere - cancelInviteById, refuseWholeInvite's
 * cancel-for-everyone branch, and cancel's clear-all branch - so on a pre-flag FabFile/Session row
 * each of them flips this predicate from "named" to "link-only". What makes that safe today is
 * `remaining`: all three zero it in the same write, and both consumers (inviteManager's
 * canViewInvite and acceptInvite) refuse an invite with none left before this result can matter.
 * So a new cancel path that clears `pending` without zeroing `remaining`, or a third consumer that
 * reads this without the `remaining` check, re-opens view-and-redeem to any authenticated holder
 * of the id. Those addresses are deliberately not moved into `refused`: that bucket means the
 * recipient declined, and a sharer cancelling is not a decline.
 */
export const isLinkOnlyInvite = (invite: LinkOnlyInviteShape): boolean => {
  if (typeof invite.isLinkOnly === 'boolean') return invite.isLinkOnly;
  const named = [
    ...(invite.recipients?.pending ?? []),
    ...(invite.recipients?.accepted ?? []),
    ...(invite.recipients?.refused ?? []),
  ];
  return named.length === 0 && (invite.type === InviteType.FabFile || invite.type === InviteType.Session);
};
