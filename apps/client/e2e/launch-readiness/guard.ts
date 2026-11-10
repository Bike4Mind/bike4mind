import { test } from '../fixtures';
import { isLocalEnv, isPreviewEnv, isProductionEnv, isStagingEnv } from '../helpers/env';

export { isPreviewEnv, isStagingEnv };

const PRODUCTION_REFUSAL = 'Launch-readiness specs never run against production; point API_URL at a preview or staging';

/**
 * Call once at the top of every launch-readiness spec file. These specs create accounts, start test
 * payments and some change admin settings, so production is refused twice: the skip keeps the tests
 * from starting and the hook fails the file loudly if the skip is ever bypassed.
 */
export function guardLaunchReadiness(): void {
  test.skip(isProductionEnv(), PRODUCTION_REFUSAL);
  test.beforeAll(() => {
    if (isProductionEnv()) throw new Error(PRODUCTION_REFUSAL);
  });
}

/**
 * Admin-setting writes are confined to ephemeral stages, the same rule core.setup applies: staging is
 * shared, so an aborted run there would leave the changed value live for everyone.
 */
export function canChangeSettings(): boolean {
  return (isPreviewEnv() || isLocalEnv()) && !isProductionEnv();
}

/**
 * True when the run has one worker, so no other test runs while this one holds a stage-wide setting
 * that would change what a concurrent signup gets. The Launch Readiness manual run passes --workers=1.
 */
export function isSingleWorkerRun(): boolean {
  return test.info().config.workers === 1;
}

export const SETTINGS_WRITE_SKIP = 'Changes an admin setting, which is done only on a preview or local stage';
export const STAGING_ONLY_SKIP =
  'Starts a Stripe payment, so it runs only on staging, the one stage whose Stripe account is known to be test mode';
