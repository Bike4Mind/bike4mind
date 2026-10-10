import {
  IFabFile,
  IGroup,
  IInviteDocument,
  IOrganization,
  ISession,
  InviteType,
  IUserDocument,
  isLinkOnlyInvite,
} from '@bike4mind/common';
import {
  FabFile,
  Group,
  Organization,
  Session,
  User,
  fabFileRepository,
  sessionRepository,
  projectRepository,
  organizationRepository,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';

export const getInviteDetails = async (invite: IInviteDocument, includeUser?: boolean) => {
  const inviteWithDetails = invite;
  let name: string | undefined = '';
  let userId = undefined;
  const docId = invite.documentId;
  switch (invite.type) {
    case InviteType.FabFile: {
      const file: IFabFile | null = await FabFile.findById(docId);
      userId = file?.userId;
      name = file?.fileName;
      break;
    }
    case InviteType.Session: {
      const session: ISession | null = await Session.findById(docId);
      userId = session?.userId;
      name = session?.name;
      break;
    }
    case InviteType.Organization: {
      const org: IOrganization | null = await Organization.findById(docId);
      name = org?.name;
      break;
    }
    case InviteType.Group: {
      const group: IGroup | null = await Group.findById(docId);
      name = group?.name;
      break;
    }
    default:
      break;
  }

  if (includeUser && userId) {
    const user = await User.findById(userId);
    if (user) {
      inviteWithDetails.username = user.username;
    }
  }

  if (name) {
    inviteWithDetails.name = name;
  }

  return inviteWithDetails;
};

export type InviteViewAccess = 'allowed' | 'expired' | 'denied';

/** 'allowed' | 'expired' (caller could view it but it lapsed) | 'denied'. Share-authorized callers still see expired invites. */
export async function canViewInvite(user: IUserDocument, invite: IInviteDocument): Promise<InviteViewAccess> {
  const expired = !!invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
  const email = user.email?.toLowerCase();
  const named = [...(invite.recipients?.pending ?? []), ...(invite.recipients?.accepted ?? [])];
  const isNamedRecipient = !!email && named.some(recipient => recipient.toLowerCase() === email);
  if (isNamedRecipient && !expired) return 'allowed';

  // A link invite names nobody, so the recipient arm can never match and the share arm never will
  // either - the person following the link is the one being granted access, not someone who
  // already holds it. Gating it out would 404 the /share/$id landing page and leave acceptInvite's
  // link path unreachable. Redeemability is the gate here: exhaustion denies, expiry yields 'expired'.
  if (isLinkOnlyInvite(invite)) {
    if (invite.remaining <= 0) return 'denied';
    return expired ? 'expired' : 'allowed';
  }

  try {
    await sharingService.authorizeByInviteType(user, invite.type, invite.documentId, {
      fabFiles: fabFileRepository,
      sessions: sessionRepository,
      projects: projectRepository,
      organizations: organizationRepository,
      groups: Group,
    });
    return 'allowed';
  } catch {
    return isNamedRecipient && expired ? 'expired' : 'denied';
  }
}

/**
 * Invitee-facing serialization for an invite. Keeps the `recipients` shape -- the
 * inbox UI checks `recipients.pending.includes(myEmail)` to flag invites addressed
 * to the caller -- but strips every OTHER recipient's email from the pending/
 * accepted/refused arrays (matching case-insensitively, as the pending match does).
 * Normalizes a Mongoose doc via toJSON first.
 *
 * Use on every route that returns an invite to an INVITEE (inbox list, single GET,
 * accept, refuse). Do NOT use on the owner-facing document-invite list, which
 * legitimately shows the full recipient set to someone with share permission.
 */
export function filterInviteRecipientsToSelf<T>(invite: T, userEmail?: string | null): Record<string, unknown> {
  const raw = invite as unknown as { toJSON?: () => Record<string, unknown> } & Record<string, unknown>;
  const plain: Record<string, unknown> = typeof raw.toJSON === 'function' ? raw.toJSON() : { ...raw };
  const recipients = plain.recipients as
    { pending?: string[]; accepted?: string[]; refused?: string[] } | null | undefined;
  if (recipients) {
    const self = userEmail?.toLowerCase();
    const keepSelf = (arr?: string[]) =>
      Array.isArray(arr) && self ? arr.filter(e => typeof e === 'string' && e.toLowerCase() === self) : [];
    plain.recipients = {
      pending: keepSelf(recipients.pending),
      accepted: keepSelf(recipients.accepted),
      refused: keepSelf(recipients.refused),
    };
  }
  // The bearer token never travels in an invitee-facing body. Whoever legitimately reaches one of
  // these routes already holds it (it is the key they addressed the request with), so echoing it
  // buys nothing and would hand a redeemable secret to any future caller of this serializer.
  delete plain.token;
  return plain;
}

/**
 * Sharer-facing serialization: drops the bearer token and nothing else.
 *
 * The create response carries a ready-made `link` that already contains the token, and the
 * document invite list has no consumer for it at all, so the bare field is a redeemable secret
 * sitting in a body for no one. Keeping it out means a share link can only be obtained from the
 * response that mints it, rather than re-read later from a cached list. Normalizes a Mongoose doc
 * via toJSON first, like its invitee-facing counterpart.
 */
export function omitInviteToken<T>(invite: T): Record<string, unknown> {
  const raw = invite as unknown as { toJSON?: () => Record<string, unknown> } & Record<string, unknown>;
  const plain: Record<string, unknown> = typeof raw.toJSON === 'function' ? raw.toJSON() : { ...raw };
  delete plain.token;
  return plain;
}

/** A recipient a sharer-facing invite view names by id rather than by address. */
export interface SharerInviteRecipientUser {
  userId: string;
  name: string;
}

/** `a***@example.com`. Shown only for an address that matches no user, so there is no id to give. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

type RecipientLists = { pending?: string[]; accepted?: string[]; refused?: string[] };

/**
 * Sharer-facing serialization: omitInviteToken, plus withholding every recipient address the viewer
 * did not supply. createInvite resolves user ids and usernames to addresses server-side, so without
 * this, inviting someone by id would hand their email back to whoever invited them.
 *
 * Each `recipients` entry stays a string, so counts and existing consumers keep working, and becomes:
 * - the address itself, for a platform admin, for the viewer's own address, or for an address this
 *   viewer typed when minting the invite (`typedRecipients`, checked against `inviterId`);
 * - otherwise the recipient's user id, listed with a display name in `recipientUsers`;
 * - otherwise (no user has that address any more) a masked address.
 * A legacy invite has no `typedRecipients`, so typed and resolved entries cannot be told apart and
 * none of its addresses are shown back to a non-admin.
 *
 * Use on every route that returns invites to someone with share access to the document. Invitees get
 * filterInviteRecipientsToSelf instead.
 */
export async function toSharerInviteViews(
  invites: unknown[],
  viewer: Pick<IUserDocument, 'id' | 'email' | 'isAdmin'>
): Promise<Record<string, unknown>[]> {
  const plains = invites.map(invite => omitInviteToken(invite));
  if (viewer.isAdmin) {
    return plains;
  }

  const viewerEmail = viewer.email?.toLowerCase();
  const isDisclosed = (plain: Record<string, unknown>, lower: string) => {
    if (lower === viewerEmail) return true;
    const typed = plain.typedRecipients as string[] | undefined;
    return !!typed && String(plain.inviterId ?? '') === viewer.id && typed.includes(lower);
  };

  const withheld = new Set<string>();
  for (const plain of plains) {
    const recipients = plain.recipients as RecipientLists | null | undefined;
    for (const entry of [
      ...(recipients?.pending ?? []),
      ...(recipients?.accepted ?? []),
      ...(recipients?.refused ?? []),
    ]) {
      if (typeof entry === 'string' && !isDisclosed(plain, entry.toLowerCase())) withheld.add(entry.toLowerCase());
    }
  }

  // Case-insensitive, matching how createInvite resolved the address (findAllByEmailsOrUsernames).
  const usersByEmail = new Map<string, SharerInviteRecipientUser>();
  if (withheld.size > 0) {
    const users = await User.find({ email: { $in: [...withheld] } }, { _id: 1, name: 1, email: 1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();
    for (const user of users) {
      const lower = user.email?.toLowerCase();
      if (lower && !usersByEmail.has(lower)) usersByEmail.set(lower, { userId: String(user._id), name: user.name });
    }
  }

  return plains.map(plain => {
    const recipients = plain.recipients as RecipientLists | null | undefined;
    if (recipients) {
      const recipientUsers = new Map<string, SharerInviteRecipientUser>();
      const view = (entries?: string[]) =>
        (entries ?? []).map(entry => {
          if (typeof entry !== 'string' || isDisclosed(plain, entry.toLowerCase())) return entry;
          const user = usersByEmail.get(entry.toLowerCase());
          if (!user) return maskEmail(entry);
          recipientUsers.set(user.userId, user);
          return user.userId;
        });
      plain.recipients = {
        ...recipients,
        pending: view(recipients.pending),
        accepted: view(recipients.accepted),
        refused: view(recipients.refused),
      };
      plain.recipientUsers = [...recipientUsers.values()];
    }
    // The typed list is itself a set of addresses, readable only by the inviter it belongs to.
    delete plain.typedRecipients;
    return plain;
  });
}
