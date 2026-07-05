import { RequestHandler } from 'express';
import { ApiKeyAlertService, AnomalyDetectionRequest } from '@server/managers/apiKeyAlertService';
import { isApiKeyAuth } from './apiKeyAuth';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * Middleware to detect anomalies in API key usage
 * Runs after apiKeyAuth to analyze request patterns and create alerts
 *
 * This middleware runs asynchronously (fire-and-forget) to avoid blocking requests.
 * Detection happens after the response is sent to minimize performance impact.
 */
export const apiKeyAnomalyDetection = (): RequestHandler => {
  return async (req, res, next) => {
    // Only run detection if request was authenticated via API key
    if (!isApiKeyAuth(req)) {
      return next();
    }

    // Ingest keys emit from load-balanced product backends with ephemeral IPs by design.
    // Running anomaly detection would constantly trip the commonIPs baseline. Skip it.
    if (req.apiKeyInfo?.scopes?.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE)) {
      return next();
    }

    // apiKeyAuth sets both apiKeyInfo (keyId, scopes) and _apiKeyUsageInfo (userId, ipAddress, endpoint)
    const apiKeyInfo = req.apiKeyInfo;
    const usageInfo = req._apiKeyUsageInfo;

    if (!apiKeyInfo || !apiKeyInfo.keyId) {
      return next();
    }

    const userId = usageInfo?.userId || req.user?.id;
    if (!userId) {
      return next();
    }

    // Use IP address and endpoint already extracted by apiKeyAuth
    const ipAddress = usageInfo?.ipAddress || 'unknown';
    const endpoint = usageInfo?.endpoint || req.originalUrl || req.url || req.path || req.baseUrl || 'unknown_endpoint';

    // Run after response finishes so detection never blocks or slows the request.
    res.once('finish', () => {
      const detectionRequest: AnomalyDetectionRequest = {
        userId,
        keyId: apiKeyInfo.keyId,
        ipAddress,
        endpoint,
        timestamp: new Date(),
      };

      // Fire and forget - don't await
      ApiKeyAlertService.detectAnomalies(detectionRequest, req.logger).catch(err => {
        // Log errors but don't throw (fail open)
        req.logger?.warn('Failed to detect API key anomalies', {
          userId,
          keyId: apiKeyInfo.keyId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    next();
  };
};
