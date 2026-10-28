/**
 * GET /api/v1/credits - the caller's spendable credit balance.
 *
 * The subject is strictly `req.user`: this handler reads no id from the query,
 * body, or path, so a credential can only ever see its own owner's balance.
 */

import { getCreditBalanceContract } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import type { Request } from 'express';
import { rateLimit } from '@server/middlewares/rateLimit';

/** Admin-set reads per minute; 0 turns the dedicated limit off (rateLimit skips a non-positive limit). */
async function creditReadsPerMinute(req: Request): Promise<number> {
  if (!req.apiKeyInfo) return 0;

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['apiRateLimitCreditsPerMin'] }
  );
  return getSettingsValue('apiRateLimitCreditsPerMin', settings, 0);
}

const handler = nextRouteForContract(getCreditBalanceContract, {
  // A pre-flight check before every batch should not burn the daily budget the
  // batch itself needs - same exemption as GET /api/v1/me.
  exemptReadsFromDailyRateLimit: true,
  // Its own per-minute window, counted per key so one key cannot spend another's reads.
  rateLimit: rateLimit({
    limit: creditReadsPerMinute,
    windowMs: 60 * 1000,
    bucket: 'credits-read',
    subject: req => (req.apiKeyInfo ? `api-key:${req.apiKeyInfo.keyId}` : undefined),
  }),
}).get(async (req, res) => {
  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ balance: req.user.currentCredits });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
