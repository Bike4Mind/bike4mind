import { InviteType, type IInviteDocumentWithDetails } from '@bike4mind/common';

const INBOX_INVITE_TYPES: readonly string[] = [
  InviteType.Project,
  InviteType.Session,
  InviteType.FabFile,
  InviteType.Organization,
  InviteType.Space,
];

/** The invites the inbox list shows; the badge counts the same set so the two never disagree. */
export const isInboxInvite = (invite: IInviteDocumentWithDetails, userEmail: string | null | undefined): boolean =>
  invite.remaining > 0 &&
  !!invite.recipients?.pending?.includes(userEmail || '') &&
  INBOX_INVITE_TYPES.includes(invite.type);
