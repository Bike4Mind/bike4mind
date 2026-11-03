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
import type { SignupRiskBand, SignupRiskSignals } from './signupRisk';
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
  /** Called only after the first staged assessment commits, including a zero-credit hold. */
  emitRiskBand?: (band: SignupRiskBand) => Promise<void>;
};

type FreeCreditLogger = { error: (message: string, ...args: unknown[]) => void };

export type GrantFreeCreditsResult = {
  withheld?: boolean;
  /** Set when the grant stayed held because the daily budget was spent. */
  budgetExhausted?: boolean;
  /** Set when a payment unlock is held until its payment settles. */
  heldUntil?: Date;
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
  { db, reason, collectRiskSignals, bypassBudget, emitRiskBand }: FreeCreditAdapters
): Promise<GrantFreeCreditsResult> => {
  const persisted = await db.users.findById(user.id);
  if (persisted?.signupGrant)
    return releaseSignupTranche(user.id, { db, reason, collectRiskSignals, bypassBudget, emitRiskBand });
  if (await protectSignupCredits(user.id, db)) {
    const alreadyGranted = await db.creditTransactions.findOne({
      transactionId: { $in: [`verify-grant:${user.id}`, legacyOtcRegisterTransactionId(user.id)] },
    });
    if (!alreadyGranted) await db.users.addTagsToUser(user.id, [PENDING_FREE_CREDITS_TAG]);
    return { creditsGranted: 0, currentCredits: null, withheld: true };
  }
  const result = await grantFlatFreeCredits(user, { db, reason, bypassBudget }, !!persisted?.referredByUserId);
  // Every outcome but a hold is final, so a held reason left from an earlier attempt must not outlive it.
  if (!result.withheld && persisted?.signupGrantHeldReason)
    await db.users.update({ id: user.id, signupGrantHeldReason: null });
  return result;
};

async function grantFlatFreeCredits(
  user: Pick<FreeCreditUser, 'id' | 'pendingCreditGrant'>,
  { db, reason, bypassBudget }: Pick<FreeCreditAdapters, 'db' | 'reason' | 'bypassBudget'>,
  referred: boolean
): Promise<GrantFreeCreditsResult> {
  const amount = await resolveFreeCreditAmount(user.pendingCreditGrant, db.adminSettings);
  if (amount <= 0) return { creditsGranted: 0, currentCredits: null };

  const transactionId = `verify-grant:${user.id}`;
  // Checked before the budget so a paid account never draws, or is tagged and held, on an exhausted day.
  const alreadyGranted = await db.creditTransactions.findOne({
    transactionId: { $in: [transactionId, legacyOtcRegisterTransactionId(user.id)] },
  });
  if (alreadyGranted) return { creditsGranted: 0, currentCredits: null };

  // The transactionId dedupes per account; the claim dedupes the open-registration default per
  // inbox, so an alias of an address that already earned it (x+1@gmail.com, x.y@gmail.com) earns
  // none. Claimed before the budget draw below so an alias that earns nothing is never held; the
  // claim is idempotent per account, so a held grant re-claims when released.
  //
  // Invite-resolved amounts are deliberately exempt. `pendingCreditGrant` is set only on
  // the invite path (register.ts), so the exemption is "an operator issued this account a specific
  // amount", not anything the signer-up controls: self-serve registration leaves it null and takes
  // the claimed branch below. The cost of an extra identity on this path is an invite code rather
  // than a fresh inbox, which is the bound we rely on instead of the claim.
  //
  // Two consequences, both accepted:
  //   - The inbox is left UNCLAIMED, so a sibling alias can still earn the open-registration
  //     default later. One inbox can therefore hold an invited grant and one default grant.
  //   - An invite carrying a target email is redeemable only by that inbox (register.ts), but an
  //     admin bulk code with `unlimitedUse` and no email is freely redeemable, so such a code is
  //     the one shape here that an actor could spread across aliases. Issuing one is an operator
  //     decision; bound it with the invite's own limits, not with this claim.
  // Claiming here instead would be wrong: it would let a self-serve signup on an alias silently
  // consume the entitlement an operator meant for the invited account.
  const isDefaultGrant = user.pendingCreditGrant === null || user.pendingCreditGrant === undefined;
  if (isDefaultGrant && !(await db.users.claimFreeCreditGrant(user.id))) {
    return { creditsGranted: 0, currentCredits: null };
  }

  // An invite-resolved amount is an explicit grant (admin/unlimited code, subscriber), not the open-signup
  // budget. A referral invitee also carries one (staging off) but is an open-signup grant: it stays metered.
  const isExplicitGrant = !isDefaultGrant && !referred;
  const budget =
    bypassBudget || isExplicitGrant
      ? { outcome: 'unmetered' as const, release: async () => {} }
      : await reserveSignupGrantBudget(db, transactionId, amount);
  if (budget.outcome === 'exhausted') {
    await db.users.addTagsToUser(user.id, [PENDING_FREE_CREDITS_TAG]);
    await db.users.update({ id: user.id, signupGrantHeldReason: 'budget_exhausted' });
    return { creditsGranted: 0, currentCredits: null, withheld: true, budgetExhausted: true };
  }

  let credited = false;
  try {
    // A concurrent grant can land after the check above; addCredits treats a repeated transactionId as
    // success, which would leave a reservation spent and let an admin release report credits an
    // earlier payout already made.
    if ((budget.outcome === 'reserved' || bypassBudget) && (await db.creditTransactions.findOne({ transactionId }))) {
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
        description: `Signup credits: ${reason}`,
      },
      {
        db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots },
        creditHolderMethods: db.users,
        duplicateTransactionId: 'throw',
      }
    );
    credited = true;
    return { creditsGranted: amount, currentCredits: holder.currentCredits };
  } catch (error) {
    // A peer already wrote this ledger row, so the draw it made is the one that counts.
    if (error instanceof DuplicateCreditTransactionError) return { creditsGranted: 0, currentCredits: null };
    // Once the ledger row is written the draw is spent; a later throw must not hand it back.
    if (!credited) await budget.release();
    throw error;
  }
}

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
