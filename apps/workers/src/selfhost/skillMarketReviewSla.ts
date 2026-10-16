import { runSkillMarketReviewSla } from '@server/skillMarket/reviewSla';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted skillMarketReviewSla cron's rate(1 day) in infra/cron.ts. */
export const SKILL_MARKET_REVIEW_SLA_INTERVAL_MS = 24 * 60 * 60_000;

export function registerSkillMarketReviewSla(worker: SelfHostWorker): void {
  worker.registerScheduledTask('skillMarketReviewSla', SKILL_MARKET_REVIEW_SLA_INTERVAL_MS, async () => {
    await runSkillMarketReviewSla();
  });
}
