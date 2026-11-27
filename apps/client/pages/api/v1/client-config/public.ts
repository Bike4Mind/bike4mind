import { getPublicClientConfigContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { resolvePublicClientConfig } from '@server/utils/publicClientConfig';

export default nextRouteForContract(getPublicClientConfigContract, {
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const body = await resolvePublicClientConfig(req);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(body);
});

export const config = { api: { externalResolver: true } };
