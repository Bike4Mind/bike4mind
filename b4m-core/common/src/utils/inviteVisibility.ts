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
 */
export const isLinkOnlyInvite = (invite: LinkOnlyInviteShape): boolean => {
  if (typeof invite.isLinkOnly === 'boolean') return invite.isLinkOnly;
  const named = [...(invite.recipients?.pending ?? []), ...(invite.recipients?.accepted ?? [])];
  return named.length === 0 && (invite.type === InviteType.FabFile || invite.type === InviteType.Session);
};
