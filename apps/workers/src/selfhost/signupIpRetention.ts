import { runSignupIpRetention } from '@workers/cron/signupIpRetention';
import type { SelfHostWorker } from './selfHostWorker';

export function registerSignupIpRetention(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('signupIpRetention', 3, async () => {
    await runSignupIpRetention();
  });
}
