import type { WebClientOptions } from '@slack/web-api';

/** Best-effort notebook DMs share this absolute budget from modal-handler entry. */
export const NOTEBOOK_DM_BUDGET_MS = 2_000;

/** Rate-limit responses must fail immediately instead of sleeping through the Slack ack. */
export const NOTEBOOK_DM_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  timeout: 1_000,
} satisfies WebClientOptions;
