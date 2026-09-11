import {
  IFabFile,
  IGroup,
  IInviteDocument,
  IOrganization,
  ISession,
  InviteType,
  IUserDocument,
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

/**
 * Gates a single-invite GET to the same population accept/refuse already redeem for:
 * a named recipient (pending or already accepted), or a caller with share authority on
 * the underlying document (the cancelInviteById/authorizeByInviteType check). Anyone
 * else must be turned into a 404 by the caller -- a 403 would confirm the id exists.
 */
export async function canViewInvite(user: IUserDocument, invite: IInviteDocument): Promise<boolean> {
  const email = user.email?.toLowerCase();
  const named = [...(invite.recipients?.pending ?? []), ...(invite.recipients?.accepted ?? [])];
  if (email && named.some(recipient => recipient.toLowerCase() === email)) {
    return true;
  }

  // A link invite names nobody (createInvite stores `pending: []` for one), so the recipient arm
  // can never match and the share arm never will either - the person following the link is the
  // one being granted access, not someone who already holds it. Gating it out would 404 the
  // /share/$id landing page and leave acceptInvite's link path unreachable. Redeemability is the
  // gate here, matching what accept already enforces.
  if (named.length === 0) {
    const expired = !!invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
    return invite.remaining > 0 && !expired;
  }

  try {
    await sharingService.authorizeByInviteType(user, invite.type, invite.documentId, {
      fabFiles: fabFileRepository,
      sessions: sessionRepository,
      projects: projectRepository,
      organizations: organizationRepository,
      groups: Group,
    });
    return true;
  } catch {
    return false;
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
  return plain;
}
