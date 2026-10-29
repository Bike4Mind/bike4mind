import { runSignupGrantHeldRelease } from '../cron/signupGrantHeldRelease';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted signupGrantHeldRelease cron's rate(1 hour) in infra/cron.ts. */
export const SIGNUP_GRANT_HELD_RELEASE_INTERVAL_MS = 60 * 60_000;

export function registerSignupGrantHeldRelease(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('signupGrantHeldRelease', SIGNUP_GRANT_HELD_RELEASE_INTERVAL_MS, async () => {
    await runSignupGrantHeldRelease();
  });
}
