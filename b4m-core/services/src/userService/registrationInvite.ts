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
  /** Sets `used` on a code that has none; false when another signup set it first. */
  claimUnused: (inviteId: string, usedAt: Date) => Promise<boolean>;
  /** Reopens a code claimed at `usedAt` that no account has redeemed yet, restoring its prior status. */
  releaseClaim: (inviteId: string, usedAt: Date, status: RegInviteStatusType) => Promise<void>;
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

/**
 * Grant total a referral invitee is owed: the invite's own startingCredits, else the admin
 * ReferralCreditsAmount. Mirrors registerUser's invite > admin-default priority (subscriber
 * allocations never apply to a refer-flow code). 0 means "no override, use the default grant".
 */
export async function referralInviteCredits(
  invite: Pick<IRegInviteDocument, 'startingCredits'>,
  adminSettings: { findBySettingName: (name: 'ReferralCreditsAmount') => Promise<{ settingValue?: unknown } | null> }
): Promise<number> {
  if (invite.startingCredits && invite.startingCredits > 0) return invite.startingCredits;
  const setting = await adminSettings.findBySettingName('ReferralCreditsAmount');
  const parsed = parseInt(String(setting?.settingValue ?? '0'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Takes a single-use code before the account is created, so two concurrent signups that both
 * passed resolveRegistrationInvite cannot both redeem it. Returns null when another signup took it
 * first; otherwise `release` reopens the code if the account is then not created.
 */
export async function claimRegistrationInvite(
  { invite, isUnlimited }: Pick<ResolvedRegistrationInvite, 'invite' | 'isUnlimited'>,
  registrationInvites: Pick<RegistrationInviteRepository, 'claimUnused' | 'releaseClaim'>
): Promise<{ release: () => Promise<void> } | null> {
  if (isUnlimited) return { release: async () => undefined };
  const usedAt = new Date();
  const priorStatus = invite.status ?? RegInviteStatusType.open;
  if (!(await registrationInvites.claimUnused(invite.id, usedAt))) return null;
  return { release: () => registrationInvites.releaseClaim(invite.id, usedAt, priorStatus) };
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
