import { runSignupIpRetention } from '@workers/cron/signupIpRetention';
import { runSubscriberNetworkRetention } from '@workers/cron/subscriberNetworkRetention';
import type { SelfHostWorker } from './selfHostWorker';

export function registerSignupIpRetention(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('signupIpRetention', 3, async () => {
    const steps = await Promise.allSettled([runSignupIpRetention(), runSubscriberNetworkRetention()]);
    const failed = steps.find(step => step.status === 'rejected');
    if (failed) throw failed.reason;
  });
}
