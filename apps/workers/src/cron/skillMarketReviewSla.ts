/**
 * Daily reminders for Skill Market versions held for human review past the SLA. Never approves.
 * Schedule: rate(1 day) on every stage (infra/cron.ts skillMarketReviewSla).
 * Self-host equivalent: apps/workers/src/selfhost/skillMarketReviewSla.ts.
 */
import { connectDB } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { runSkillMarketReviewSla } from '@server/skillMarket/reviewSla';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'skillMarketReviewSla' } });

export async function runSkillMarketReviewSlaCron(): Promise<{ reminded: number }> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  const result = await runSkillMarketReviewSla();
  logger.info('[skillMarketReviewSla] done', result);
  return result;
}

export const handler = async () => runSkillMarketReviewSlaCron();
