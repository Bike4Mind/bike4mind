import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.e2e') });

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL_SLOW_RESPONSES || '';
export const CREDITS_THRESHOLD = 30;

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
