import { baseApi } from '@server/middlewares/baseApi';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { apiKeyAlertRepository } from '@bike4mind/database/auth';

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
      usage: apiKey.usage,
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
