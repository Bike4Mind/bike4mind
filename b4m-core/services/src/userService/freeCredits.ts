import {
  CreditHolderType,
  IAdminSettingsRepository,
  ICreditLotRepository,
  ICreditTransactionRepository,
  IUserRepository,
  type IUserDocument,
  PENDING_FREE_CREDITS_TAG,
  settingsMap,
  type SignupProtection,
} from '@bike4mind/common';
import { addCredits, DuplicateCreditTransactionError } from '../creditService';
import type { SignupRiskSignals } from './signupRisk';
import { releaseSignupTranche } from './stagedSignupGrant';
import { protectSignupCredits } from './signupProtection';
import { reserveSignupGrantBudget } from './signupGrantBudget';

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
    signupProtection?: SignupProtection;
  };
  reason: string;
  /** Network signals for a staged grant's first assessment; without it only signupMeta is read. */
  collectRiskSignals?: (user: IUserDocument) => Promise<SignupRiskSignals>;
  /** Admin overrides and a card unlock of a held tranche pay without drawing the daily signup grant budget. */
  bypassBudget?: boolean;
};

type FreeCreditLogger = { error: (message: string, ...args: unknown[]) => void };

export type GrantFreeCreditsResult = {
  withheld?: boolean;
  /** Set when the grant stayed held because the daily budget was spent. */
  budgetExhausted?: boolean;
  creditsGranted: number;
  currentCredits: number | null;
};

export type ReleasePendingFreeCreditsResult = {
  released: boolean;
  /** True when the release stopped because the daily signup grant budget was spent. */
  budgetExhausted?: boolean;
  /** True when the grant threw; the tag is kept for a retry. */
  failed?: boolean;
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
  { db, reason, collectRiskSignals, bypassBudget }: FreeCreditAdapters
): Promise<GrantFreeCreditsResult> => {
  const persisted = await db.users.findById(user.id);
  if (persisted?.signupGrant) return releaseSignupTranche(user.id, { db, reason, collectRiskSignals, bypassBudget });
  if (await protectSignupCredits(user.id, db)) {
    const alreadyGranted = await db.creditTransactions.findOne({
      transactionId: { $in: [`verify-grant:${user.id}`, legacyOtcRegisterTransactionId(user.id)] },
    });
    if (!alreadyGranted) await db.users.addTagsToUser(user.id, [PENDING_FREE_CREDITS_TAG]);
    return { creditsGranted: 0, currentCredits: null, withheld: true };
  }
  const amount = await resolveFreeCreditAmount(user.pendingCreditGrant, db.adminSettings);
  if (amount <= 0) return { creditsGranted: 0, currentCredits: null };

  const legacyGrant = await db.creditTransactions.findOne({
    transactionId: legacyOtcRegisterTransactionId(user.id),
  });
  if (legacyGrant) return { creditsGranted: 0, currentCredits: null };

  const transactionId = `verify-grant:${user.id}`;
  const budget = bypassBudget
    ? { outcome: 'unmetered' as const, release: async () => {} }
    : await reserveSignupGrantBudget(db, transactionId, amount);
  if (budget.outcome === 'exhausted') {
    await db.users.addTagsToUser(user.id, [PENDING_FREE_CREDITS_TAG]);
    await db.users.update({ id: user.id, signupGrantHeldReason: 'budget_exhausted' });
    return { creditsGranted: 0, currentCredits: null, withheld: true, budgetExhausted: true };
  }

  let credited = false;
  try {
    // addCredits treats a repeated transactionId as success, which would leave a reservation spent and
    // let an admin release report credits an earlier payout already made.
    if ((budget.outcome === 'reserved' || bypassBudget) && (await db.creditTransactions.findOne({ transactionId }))) {
      await budget.release();
      return { creditsGranted: 0, currentCredits: null };
    }
    // The transactionId dedupes per account; the claim dedupes the open-registration default per
    // inbox, so an alias of an address that already earned it (x+1@gmail.com, x.y@gmail.com) earns
    // none. An invite-resolved amount is an explicit grant to that account and is not claimed.
    const isDefaultGrant = user.pendingCreditGrant === null || user.pendingCreditGrant === undefined;
    if (isDefaultGrant && !(await db.users.claimFreeCreditGrant(user.id))) {
      await budget.release();
      return { creditsGranted: 0, currentCredits: null };
    }

    const holder = await addCredits(
      {
        ownerId: user.id,
        ownerType: CreditHolderType.User,
        credits: amount,
        type: 'generic_add',
        transactionId,
        reason,
      },
      {
        db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots },
        creditHolderMethods: db.users,
        duplicateTransactionId: 'throw',
      }
    );
    credited = true;
    if (persisted?.signupGrantHeldReason) await db.users.update({ id: user.id, signupGrantHeldReason: null });
    return { creditsGranted: amount, currentCredits: holder.currentCredits };
  } catch (error) {
    // A peer already wrote this ledger row, so the draw it made is the one that counts.
    if (error instanceof DuplicateCreditTransactionError) return { creditsGranted: 0, currentCredits: null };
    // Once the ledger row is written the draw is spent; a later throw must not hand it back.
    if (!credited) await budget.release();
    throw error;
  }
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
  try {
    if (!tags.includes(PENDING_FREE_CREDITS_TAG)) {
      await protectSignupCredits(user.id, adapters.db);
      return { released: false, creditsGranted: 0, currentCredits: null, patch: {} };
    }
    const { creditsGranted, currentCredits, withheld, budgetExhausted } = await grantFreeCredits(user, adapters);
    if (withheld) return { released: false, budgetExhausted, creditsGranted: 0, currentCredits: null, patch: {} };
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
    return { released: false, failed: true, creditsGranted: 0, currentCredits: null, patch: {} };
  }
};
