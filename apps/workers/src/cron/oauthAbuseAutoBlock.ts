/**
 * Blocks IPs with a burst of failed OAuth sign-ins, with escalating block durations. The logic and
 * its settings live in server-utils; the admin evaluate endpoint calls the same runner.
 * Schedule: rate(1 minute) on prod and dev (infra/cron.ts oauthAbuseAutoBlockCron).
 * Self-host equivalent: apps/workers/src/selfhost/oauthAbuseAutoBlock.ts.
 */
import { Logger } from '@bike4mind/observability';
import { connectDB } from '@bike4mind/database';
import { runOauthAbuseAutoBlock } from '@bike4mind/server-utils/security/oauthAbuseAutoBlock';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

export { runOauthAbuseAutoBlock };

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runOauthAbuseAutoBlock();
  if (result.blocked.length > 0) Logger.info('[oauthAbuseAutoBlock] blocked', { blocked: result.blocked });
  if (result.failed.length > 0) Logger.error('[oauthAbuseAutoBlock] failed to block', { failed: result.failed });
  return result;
};
