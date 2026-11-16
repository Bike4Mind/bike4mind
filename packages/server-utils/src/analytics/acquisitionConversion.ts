import {
  attributedTouch,
  type AcquisitionTouchKind,
  type AttributedTouch,
  type StoredAcquisition,
} from '../app/utils/acquisitionTouch';
import { findEligibleSignups } from './activationFunnel';
import { loadCountingContext } from './signupCohort';

/**
 * Signup cohorts grouped by the campaign touch stored on the user at signup (user.acquisition, written by
 * recordSignupAcquisition in apps/client/server/analytics/funnel.ts). The admin Analytics acquisition section
 * and its Users drill-down both resolve through attributedSignups, so their counts agree.
 */

export type AttributedSignup = { id: string; signupAt: Date; touch: AttributedTouch | null };

/**
 * Every active-eligible signup created in [start, end), with its cohort touch. Accounts marked isInternal
 * are left out too. Unlike the activation funnel there is no minimum age: maturity is judged per metric.
 * More than FUNNEL_COHORT_MAX signups is refused with a 422.
 */
export async function attributedSignups(
  { start, end }: { start: Date; end: Date },
  { touch, maxTimeMS }: { touch: AcquisitionTouchKind; maxTimeMS: () => number }
): Promise<AttributedSignup[]> {
  const ctx = await loadCountingContext();
  const users = await findEligibleSignups<{ isInternal?: boolean; acquisition?: StoredAcquisition }>(
    { $gte: start, $lt: end },
    { ctx, maxTimeMS: maxTimeMS(), extraFields: 'isInternal acquisition.firstTouch acquisition.lastTouch' }
  );
  return users
    .filter(user => !user.isInternal)
    .map(user => ({
      id: String(user._id),
      signupAt: new Date(user.createdAt),
      touch: attributedTouch(user.acquisition, touch),
    }));
}
