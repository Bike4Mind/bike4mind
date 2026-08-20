import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.e2e') });

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL_SLOW_RESPONSES || '';
/**
 * Ceiling for a model's AVERAGE credits on the fixed CREDITS_PROMPT turn
 * (see notebook.spec.ts). Deliberately loose, and temporary at this value.
 *
 * 30 was failing daily for two unrelated reasons, neither of them a regression:
 *
 * - GPT-5.5 settles at 39-40 on every run, warm or cold. OpenAI cached tokens
 *   are not passed through to billing (see openaiBackend.ts, where
 *   prompt_tokens_details.cached_tokens is captured but deliberately not
 *   forwarded), so every turn bills the full input rate. Whether that is
 *   correct COGS or an overcharge is still open.
 * - Claude 4.7 Opus averages ~50 whenever warmup.setup.ts's warm has aged past
 *   the 5m prompt-cache TTL: run 1 re-pays the 1.25x cache write (~91 credits)
 *   and run 2 reads it back (~8). Cold/warm differ by ~12.5x, which is the
 *   cache multipliers, not prompt growth.
 *
 * 60 clears both. It deliberately does NOT clear a both-runs-cold average
 * (~91): that stays a failure, because it means warmup is not working at all,
 * which is worth being told about.
 *
 * Do not raise this again to accommodate a new number. A credit figure mixes
 * prompt size with cache state, provider pricing and stochastic rounding, so it
 * cannot isolate a regression. Prompt-size guarding belongs in a token budget -
 * see #1844, which owns replacing this constant.
 */
export const CREDITS_THRESHOLD = 60;

export interface ModelCreditsData {
  model: string;
  avgCredits: number | null;
  avgDuration: string | null; // e.g. "6.81 secs."
  successRate: string; // e.g. "2/2"
}

async function post(text: string): Promise<void> {
  if (!WEBHOOK_URL) {
    console.log('[Slack] SLACK_WEBHOOK_URL not set — skipping notification');
    return;
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn('[Slack] Failed to send notification:', (err as Error).message);
  }
}

/** Send the post-run credits summary to Slack. */
export async function notifyCreditsReport(entries: ModelCreditsData[]): Promise<void> {
  if (entries.length === 0) return;
  const lines = entries
    .map(e => {
      const failed = e.avgCredits === null || e.avgCredits > CREDITS_THRESHOLD;
      return `• ${e.model} — credits: ${e.avgCredits ?? 'n/a'} ${failed ? ':x:' : ':white_check_mark:'}`;
    })
    .join('\n');
  await post(`💳 *AI Credits Report (Playwright)*\n${lines}`);
}
