import { CreditHolderType, resolveSignupGrantSchedule, type IUserDocument, type SignupGrant } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { addCreditsWithLedgerRow, DuplicateCreditTransactionError } from '../creditService';
import type { FreeCreditAdapters } from './freeCredits';
import { accountBlockReasons, isAiAccessRevoked } from './accountState';
import { isSignupGrantHeldForReview } from './signupRisk';
import { reserveSignupGrantBudget, type SignupGrantBudgetReservation } from './signupGrantBudget';

export type InviteBonusResult = { creditsGranted: number; budgetExhausted?: boolean };

type InviteBonusAdapters = Pick<FreeCreditAdapters, 'db' | 'bypassBudget'>;

class InviteBonusClaimDeniedError extends Error {}

export const inviteBonusTransactionId = (userId: string) => `invite-bonus:${userId}`;

/** An invited account whose signup tranche was paid in full and that has not had its bonus yet. */
function isInviteBonusEligible(
  user: IUserDocument | null | undefined
): user is IUserDocument & { signupGrant: SignupGrant } {
  const grant = user?.signupGrant;
  if (!user?.signupInvite || !grant || grant.inviteBonusPaid != null) return false;
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
  if (!isInviteBonusEligible(await db.users.findById(userId))) return { creditsGranted: 0 };
  const { inviteBonusCredits: amount } = await resolveSignupGrantSchedule(db.adminSettings);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { creditsGranted: 0 };

  const transactionId = inviteBonusTransactionId(userId);
  const reservations: SignupGrantBudgetReservation[] = [];
  const releaseReservations = () => Promise.all(reservations.map(held => held.release()));
  try {
    const result = await withTransaction<InviteBonusResult>(async () => {
      const user = await db.users.findById(userId);
      if (!isInviteBonusEligible(user)) return { creditsGranted: 0 };
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
      const updated = await db.users.update({
        id: userId,
        signupGrant: { ...user.signupGrant, inviteBonusPaid: amount },
      });
      if (!updated) throw new Error('Invite bonus account update failed');
      return { creditsGranted: amount };
    });
    if (result.creditsGranted === 0) await releaseReservations();
    return result;
  } catch (error) {
    // A duplicate ledger row means a concurrent call paid the bonus: its draw stays spent.
    if (error instanceof DuplicateCreditTransactionError) return { creditsGranted: 0 };
    await releaseReservations();
    if (error instanceof InviteBonusClaimDeniedError) return { creditsGranted: 0 };
    throw error;
  }
}
