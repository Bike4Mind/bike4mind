import { runOauthAbuseAutoBlock } from '../cron/oauthAbuseAutoBlock';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted oauthAbuseAutoBlock cron's rate(1 minute) in infra/cron.ts. */
export const OAUTH_ABUSE_AUTO_BLOCK_INTERVAL_MS = 60_000;

export function registerOauthAbuseAutoBlock(worker: Pick<SelfHostWorker, 'registerScheduledTask'>): void {
  worker.registerScheduledTask(
    'oauthAbuseAutoBlock',
    OAUTH_ABUSE_AUTO_BLOCK_INTERVAL_MS,
    async () => {
      await runOauthAbuseAutoBlock();
    },
    { runOnStartup: true }
  );
}
