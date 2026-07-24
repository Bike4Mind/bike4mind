import { baseApi } from '@server/middlewares/baseApi';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { apiKeyAlertRepository } from '@bike4mind/database/auth';
import { getApiKeyRateLimitUsage } from '@server/utils/apiKeyRateLimitCheck';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKeys = await userApiKeyRepository.findByUserId(userId);
  const activeAlerts = await apiKeyAlertRepository.findActiveByUserId(userId);

  const alertsByKey = activeAlerts.reduce<Record<string, typeof activeAlerts>>((acc, alert) => {
    if (!acc[alert.keyId]) {
      acc[alert.keyId] = [];
    }
    acc[alert.keyId].push(alert);
    return acc;
  }, {});

  // Live counts come from the rate-limit cache counters, not the key doc's
  // usage.* fields (those are never incremented - see apiKeyRateLimitCheck).
  const liveUsageByKey = Object.fromEntries(
    await Promise.all(apiKeys.map(async apiKey => [apiKey.id, await getApiKeyRateLimitUsage(apiKey.id)] as const))
  );

  const items = apiKeys.map(apiKey => {
    const alerts = alertsByKey[apiKey.id] ?? [];
    return {
      id: apiKey.id,
      name: apiKey.name,
      status: apiKey.status,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      rateLimit: apiKey.rateLimit,
      liveUsage: liveUsageByKey[apiKey.id],
      metadata: apiKey.metadata,
      alerts: alerts.map(alert => ({
        id: alert.id,
        alertType: alert.alertType,
        message: alert.message,
        detectedAt: alert.detectedAt,
        metadata: alert.metadata,
      })),
    };
  });

  return res.status(200).json({ items });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
