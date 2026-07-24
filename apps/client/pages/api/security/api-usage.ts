import { baseApi } from '@server/middlewares/baseApi';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { apiKeyAlertRepository } from '@bike4mind/database/auth';
import { apiKeyUsageLogRepository } from '@bike4mind/database/auth';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKeys = await userApiKeyRepository.findByUserId(userId);
  const activeAlerts = await apiKeyAlertRepository.findActiveByUserId(userId);

  // The UserApiKey.usage counters are never written in production (#773), so the
  // displayed request counts were always 0. Derive them from the request log, which
  // records every API-key request. "Total" reflects the log's 90-day retention window.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const requestCounts = await apiKeyUsageLogRepository.countRequestsByKeyForUser(userId, dayStart);

  const alertsByKey = activeAlerts.reduce<Record<string, typeof activeAlerts>>((acc, alert) => {
    if (!acc[alert.keyId]) {
      acc[alert.keyId] = [];
    }
    acc[alert.keyId].push(alert);
    return acc;
  }, {});

  const items = apiKeys.map(apiKey => {
    const alerts = alertsByKey[apiKey.id] ?? [];
    const counts = requestCounts[apiKey.id];
    return {
      id: apiKey.id,
      name: apiKey.name,
      status: apiKey.status,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      rateLimit: apiKey.rateLimit,
      usage: {
        ...apiKey.usage,
        totalRequests: counts?.totalRequests ?? 0,
        requestsToday: counts?.requestsToday ?? 0,
      },
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
