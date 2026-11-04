import { CreditHolderType, resolveSignupGrantSchedule, type IUserDocument, type SignupGrant } from '@bike4mind/common';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters } from './freeCredits';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';
import { inCallerTransaction } from './callerTransaction';
import { isSignupGrantHeldForReview } from './signupRisk';
import { reserveSignupGrantBudget, type SignupGrantBudgetReservation } from './signupGrantBudget';

export type InviteBonusResult = { creditsGranted: number; budgetExhausted?: boolean };

type InviteBonusAdapters = Pick<FreeCreditAdapters, 'db' | 'bypassBudget'> & {
  /**
   * Set only by a caller that just confirmed the organization still pays
   * (apps/client/server/credits/orgInviteBonus.ts); an organization invite's bonus is never paid without it.
   */
  orgStandingVerified?: boolean;
};

class InviteBonusClaimDeniedError extends Error {}
class InviteBonusAlreadyMarkedError extends Error {}

export const inviteBonusTransactionId = (userId: string) => `invite-bonus:${userId}`;

/** An invited account whose signup tranche was paid in full and that has not had its bonus yet. */
export function isInviteBonusEligible(
  user: IUserDocument | null | undefined,
  orgStandingVerified: boolean
): user is IUserDocument & { signupGrant: SignupGrant } {
  const grant = user?.signupGrant;
  if (!user?.signupInvite || !grant || grant.inviteBonusPaid != null) return false;
  if (user.signupInvite.source === 'organization' && !orgStandingVerified) return false;
  if (grant.stage === 'pending_email' || user.signupGrantHeldReason) return false;
  if (accountBlockReasons(user).length || isAiAccessRevoked(user) || isSignupGrantHeldForReview(user)) return false;
  // A reviewed or reduced tranche earns no bonus.
  return user.signupGrantAssessment?.credits === grant.signupCredits;
}

/**
 * Pays the live signupGrantInviteBonusCredits once to an invited account, from the signup pool and
 * outside the staged grant (see SignupGrant.inviteBonusPaid), so the drip pays what it would without it.
 * A bonus of 0 writes nothing. An exhausted pool leaves it unpaid for a later call to retry.
 */
export async function payInviteBonus(userId: string, adapters: InviteBonusAdapters): Promise<InviteBonusResult> {
  const { db } = adapters;
  const orgStandingVerified = adapters.orgStandingVerified === true;
  if (!isInviteBonusEligible(await db.users.findById(userId), orgStandingVerified)) return { creditsGranted: 0 };
  const { inviteBonusCredits: amount } = await resolveSignupGrantSchedule(db.adminSettings);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    // Settled at 0 so raising the setting later does not pay accounts that signed up while it was off.
    await db.users.markInviteBonusPaid(userId, 0);
    return { creditsGranted: 0 };
  }

  const transactionId = inviteBonusTransactionId(userId);
  const reservations: SignupGrantBudgetReservation[] = [];
  const releaseReservations = () => Promise.all(reservations.map(held => held.release()));
  try {
    const result = await inCallerTransaction<InviteBonusResult>(async () => {
      const user = await db.users.findById(userId);
      if (!isInviteBonusEligible(user, orgStandingVerified)) return { creditsGranted: 0 };
      if (!adapters.bypassBudget) {
        const reservation = await reserveSignupGrantBudget(db, transactionId, amount, { pool: 'signup' });
        reservations.push(reservation);
        if (reservation.outcome === 'exhausted') return { creditsGranted: 0, budgetExhausted: true };
      }
      // A denied claim may have aborted the Mongo transaction, so leave it by throwing.
      if (!(await db.users.claimFreeCreditGrant(userId))) throw new InviteBonusClaimDeniedError();
      await addCreditsWithLedgerRow(
        {
          ownerId: userId,
          ownerType: CreditHolderType.User,
          credits: amount,
          type: 'generic_add',
          transactionId,
          reason: 'signup_invite_bonus',
          description: 'Signup credits: invite bonus',
        },
        {
          db: { creditTransactions: db.creditTransactions, creditLots: db.creditLots },
          creditHolderMethods: db.users,
          duplicateTransactionId: 'throw',
        }
      );
      // A path write, so a concurrent drip or unlock write to signupGrant cannot be overwritten here.
      if (!(await db.users.markInviteBonusPaid(userId, amount))) throw new InviteBonusAlreadyMarkedError();
      return { creditsGranted: amount };
    });
    if (result.creditsGranted === 0) await releaseReservations();
    return result;
  } catch (error) {
    // A duplicate ledger row means a concurrent call paid the bonus: its draw stays spent.
    if (error instanceof DuplicateCreditTransactionError) return { creditsGranted: 0 };
    await releaseReservations();
    if (error instanceof InviteBonusClaimDeniedError || error instanceof InviteBonusAlreadyMarkedError)
      return { creditsGranted: 0 };
    throw error;
  }
}
