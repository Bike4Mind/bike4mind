import {
  isFreeTierExempt,
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  PAID_PLAN_ENTITLEMENT_KEY,
  ServiceUnavailableError,
} from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

type FreeTierUser = Parameters<typeof isFreeTierExempt>[0];

export const holdsPaidPlan = (entitlementKeys: readonly string[]): boolean =>
  entitlementKeys.includes(PAID_PLAN_ENTITLEMENT_KEY);

export type PaidFeatureAdmissionInput = {
  user: FreeTierUser;
  /**
   * A deployment with no paid plans (self-host): nobody can hold the plan, so the gate is off. Deliberately not the
   * free-tier model gate setting: opening models to free users must not open paid features with them.
   */
  planlessDeployment: boolean;
  getEntitlements: () => Promise<string[]>;
  /** Shown in the refusal, e.g. "Video export". */
  featureLabel: string;
};

/**
 * The free-tier rule of modelAdmission for a paid feature that is not a model call (a Studio render): free
 * accounts are refused with the same ForbiddenError and error code as a paid-only model, so the client shows
 * its usual upgrade prompt. Admins and developer-tagged users are exempt. A failed entitlement read is a
 * retryable ServiceUnavailableError, never an upgrade prompt.
 */
export async function assertPaidFeatureAccess({
  user,
  planlessDeployment,
  getEntitlements,
  featureLabel,
}: PaidFeatureAdmissionInput): Promise<void> {
  if (planlessDeployment || isFreeTierExempt(user)) return;
  let entitlementKeys: string[];
  try {
    entitlementKeys = await getEntitlements();
  } catch (error) {
    Logger.warn('paidFeatureAdmission: entitlement read failed; cannot verify the plan', error);
    throw new ServiceUnavailableError(`Could not verify your plan for ${featureLabel.toLowerCase()}. Please try again.`);
  }
  if (holdsPaidPlan(entitlementKeys)) return;
  throw new ForbiddenError(`${featureLabel} requires a paid plan. Upgrade your plan to use it.`, {
    errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  });
}
