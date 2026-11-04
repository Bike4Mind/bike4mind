import {
  IRegInviteDocument,
  RegInviteSource,
  RegInviteStatusType,
  type RepositoryUpdateOptions,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

export interface RegistrationInviteRepository {
  findByCode: (code: string) => Promise<IRegInviteDocument | null>;
  update: (
    invite: Partial<IRegInviteDocument>,
    options?: RepositoryUpdateOptions<IRegInviteDocument>
  ) => Promise<unknown>;
}

export interface ResolvedRegistrationInvite {
  invite: IRegInviteDocument;
  isUnlimited: boolean;
  /** Sent through the refer flow by a user; admin, subscriber, unlimited and pre-`source` codes are not. */
  isReferral: boolean;
}

/**
 * Looks up a registration invite code and enforces expiry, single use and the email binding.
 * Returns null for a missing, empty or whitespace-only code; throws BadRequestError for a code
 * that cannot be redeemed by `normalizedEmail` (already lower-cased and trimmed).
 */
export async function resolveRegistrationInvite(
  code: string | null | undefined,
  normalizedEmail: string,
  registrationInvites: Pick<RegistrationInviteRepository, 'findByCode'>
): Promise<ResolvedRegistrationInvite | null> {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) return null;

  const invite = await registrationInvites.findByCode(trimmed);
  if (!invite) throw new BadRequestError('Invalid invite code');
  const isUnlimited = Boolean(invite.unlimitedUse);
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    throw new BadRequestError('Invite code has expired');
  }
  if (invite.used && !isUnlimited) throw new BadRequestError('Invite code already used');

  // An invite issued to a specific inbox is redeemable only by that inbox, so a leaked or
  // forwarded referral code cannot move its grant to another account. Admin bulk codes carry
  // no email and stay freely redeemable.
  if (invite.email && invite.email.toLowerCase().trim() !== normalizedEmail) {
    throw new BadRequestError('This invite code was issued for a different email address');
  }

  return { invite, isUnlimited, isReferral: !isUnlimited && invite.source === RegInviteSource.referral };
}

/** Records `userId`'s use of the invite: closes a single-use code, appends history for an unlimited one. */
export async function redeemRegistrationInvite(
  { invite, isUnlimited }: Pick<ResolvedRegistrationInvite, 'invite' | 'isUnlimited'>,
  userId: string,
  registrationInvites: Pick<RegistrationInviteRepository, 'update'>
): Promise<void> {
  const usedAt = new Date();
  invite.usageHistory = [...(invite.usageHistory ?? []), { userId, usedAt }];

  if (isUnlimited) {
    delete invite.used;
    delete invite.usedbyId;
    invite.status = RegInviteStatusType.open;
    await registrationInvites.update(
      { id: invite.id, usageHistory: invite.usageHistory, status: invite.status },
      { unset: ['used', 'usedbyId'] }
    );
    return;
  }

  invite.used = usedAt;
  invite.usedbyId = userId;
  invite.status = RegInviteStatusType.used;
  await registrationInvites.update(
    {
      id: invite.id,
      usageHistory: invite.usageHistory,
      used: invite.used,
      usedbyId: invite.usedbyId,
      status: invite.status,
    },
    undefined
  );
}
