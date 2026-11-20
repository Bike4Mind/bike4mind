import { Resource } from 'sst';
import { Config } from '@bike4mind/server-utils/utils/config';
import { baselineWindowSchema, DAY_MS } from '@bike4mind/server-utils/analytics/signupBaseline';
import { toUtcDay } from '@bike4mind/server-utils/analytics/externalActiveUsers';
import { runSignupBaselineReport } from '@bike4mind/server-utils/analytics/signupBaselineReport';
import { connectDB } from '@bike4mind/db-core';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';

/** Emit events individually so a busy first day cannot overflow one log record. */
export async function handler() {
  if (Resource.App.stage !== 'production') return { status: 'skipped' };
  const until = new Date(toUtcDay(new Date()) * DAY_MS);
  const since = new Date(z.iso.datetime().parse(process.env.SIGNUP_BASELINE_SINCE));
  const window = baselineWindowSchema.parse({ since, until });
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  const { census, ...summary } = await runSignupBaselineReport({
    ...window,
    staffDomains: process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS,
    testPattern: process.env.ANALYTICS_TEST_PATTERN,
  });
  Logger.info('signup baseline report', { report: 'signup-baseline', ...summary });
  for (const { timeline, ...account } of census) {
    Logger.info('signup baseline census', { report: 'signup-baseline-census', window: summary.window, ...account });
    for (const event of timeline) {
      Logger.info('signup baseline event', {
        report: 'signup-baseline-event',
        window: summary.window,
        userId: account.userId,
        ...event,
      });
    }
  }
  return { status: 'success', signups: summary.total.signups };
}
