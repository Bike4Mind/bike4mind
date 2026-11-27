import { runApiKeyExpiryReminder } from '@workers/cron/apiKeyExpiryReminder';
import type { SelfHostWorker } from './selfHostWorker';

export function registerApiKeyExpiryReminder(worker: Pick<SelfHostWorker, 'registerDailyUtcTask'>): void {
  worker.registerDailyUtcTask('apiKeyExpiryReminder', 14, async () => {
    const result = await runApiKeyExpiryReminder();
    if (result.failed > 0) throw new Error(`API key expiry reminder failed for ${result.failed} key(s)`);
  });
}
