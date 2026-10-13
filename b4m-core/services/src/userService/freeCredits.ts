import {
  CreditHolderType,
  IAdminSettingsRepository,
  ICreditLotRepository,
  ICreditTransactionRepository,
  IUserRepository,
  PENDING_FREE_CREDITS_TAG,
  settingsMap,
} from '@bike4mind/common';
import { addCredits } from '../creditService';

type FreeCreditUser = {
  id: string;
  tags?: string[] | null;
  pendingCreditGrant?: number | null;
};

export type FreeCreditAdapters = {
  db: {
    adminSettings: IAdminSettingsRepository;
    creditTransactions: ICreditTransactionRepository;
    creditLots?: ICreditLotRepository;
    users: IUserRepository;
  };
  reason: string;
};

type FreeCreditLogger = { error: (message: string, ...args: unknown[]) => void };

export type GrantFreeCreditsResult = {
  creditsGranted: number;
  currentCredits: number | null;
};

export type ReleasePendingFreeCreditsResult = {
  released: boolean;
  creditsGranted: number;
  /** Balance after the grant; null when nothing was granted. */
  currentCredits: number | null;
  /** Fields the caller merges into its own single user update. Empty when nothing was released. */
  patch: { tags?: string[]; pendingCreditGrant?: null };
};

/** An explicit (invite-resolved) amount wins; the defaultFreeCredits setting is the open-registration fallback. */
export const resolveFreeCreditAmount = async (
  pendingCreditGrant: number | null | undefined,
  adminSettings: IAdminSettingsRepository
): Promise<number> => {
  if (pendingCreditGrant !== null && pendingCreditGrant !== undefined) return pendingCreditGrant;
  const setting = await adminSettings.findBySettingName('defaultFreeCredits');
  const parsed = settingsMap.defaultFreeCredits.schema.safeParse(setting?.settingValue);
  return parsed.success ? parsed.data : 0;
};

/**
 * Before the shared verify-grant id, registerViaOTC keyed its grant on this id. An account whose
 * grant committed under it but whose follow-up user write failed is still tagged.
 */
const legacyOtcRegisterTransactionId = (userId: string) => `otc-register-grant:${userId}`;

/**
 * Every runtime flat free grant (verify link, OTC register/login, OAuth) keys on one stable
 * transactionId, so addCredits' unique key stops those paths from double-crediting each other,
 * and a grant already committed under the legacy OTC-register id counts as granted. Paths that
 * call addCredits directly under another id (e.g. admin adjustments) are outside this guarantee.
 */
export const grantFreeCredits = async (
  user: Pick<FreeCreditUser, 'id' | 'pendingCreditGrant'>,
  { db, reason }: FreeCreditAdapters
): Promise<GrantFreeCreditsResult> => {
  const amount = await resolveFreeCreditAmount(user.pendingCreditGrant, db.adminSettings);
  if (amount <= 0) return { creditsGranted: 0, currentCredits: null };

  const legacyGrant = await db.creditTransactions.findOne({
    transactionId: legacyOtcRegisterTransactionId(user.id),
  });
  if (legacyGrant) return { creditsGranted: 0, currentCredits: null };

  const holder = await addCredits(
    {
      ownerId: user.id,
      ownerType: CreditHolderType.User,
      credits: amount,
      type: 'generic_add',
      transactionId: `verify-grant:${user.id}`,
      reason,
    },
    { db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots }, creditHolderMethods: db.users }
  );
  return { creditsGranted: amount, currentCredits: holder.currentCredits };
};

/**
 * Grants the deferred free credits for a user tagged PENDING_FREE_CREDITS_TAG and returns the
 * patch that clears the tag. The tag is only stripped after the grant succeeds; on failure it
 * stays as the retry breadcrumb and this never throws (callers are already past the point of
 * proving email ownership).
 */
export const releasePendingFreeCredits = async (
  user: FreeCreditUser,
  adapters: FreeCreditAdapters & { logger: FreeCreditLogger }
): Promise<ReleasePendingFreeCreditsResult> => {
  const tags = user.tags ?? [];
  if (!tags.includes(PENDING_FREE_CREDITS_TAG))
    return { released: false, creditsGranted: 0, currentCredits: null, patch: {} };

  try {
    const { creditsGranted, currentCredits } = await grantFreeCredits(user, adapters);
    return {
      released: true,
      creditsGranted,
      currentCredits,
      patch: { tags: tags.filter(tag => tag !== PENDING_FREE_CREDITS_TAG), pendingCreditGrant: null },
    };
  } catch (error) {
    adapters.logger.error(
      `Free credit grant failed for user ${user.id}; keeping ${PENDING_FREE_CREDITS_TAG} for retry`,
      error
    );
    return { released: false, creditsGranted: 0, currentCredits: null, patch: {} };
  }
};
