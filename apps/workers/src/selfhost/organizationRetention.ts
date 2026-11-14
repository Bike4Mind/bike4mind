import type { SelfHostWorker } from './selfHostWorker';

export function registerOrganizationRetention(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask('organizationRetention', 60 * 60_000, async () => {
    await (await import('@workers/cron/organizationRetention')).runOrganizationRetention();
  });
}
