import { apiKeyAlertRepository } from '@bike4mind/database/auth';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { ApiKeyUsageManager } from './apiKeyUsageManager';
import { IUserApiKeyBaseline } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * Configuration for anomaly detection thresholds
 */
const DETECTION_CONFIG = {
  // High rate detection: alert if current rate exceeds baseline by this multiplier
  HIGH_RATE_MULTIPLIER: 2.0,
  // Minimum baseline rate to consider (avoid false positives on very low usage)
  MIN_BASELINE_RATE: 0.1, // requests per hour
  // Minimum current rate to alert (avoid alerting on tiny spikes)
  MIN_CURRENT_RATE: 10, // requests per hour
  // Absolute rate thresholds - alert regardless of baseline to catch keys with elevated baselines
  ABSOLUTE_RPH_THRESHOLD: 500, // Alert if >500 req/hr regardless of baseline
  ABSOLUTE_RPD_THRESHOLD: 5000, // Alert if >5,000 req/day regardless of baseline
  // Sensitive endpoints that should trigger unusual_pattern alerts
  SENSITIVE_ENDPOINTS: ['/api/admin', '/api/user-api-keys', '/api/auth'],
} as const;

/**
 * IP addresses that should not trigger new_ip alerts (internal/whitelist)
 */
const WHITELIST_IPS = ['127.0.0.1', '::1', 'localhost'];

export interface AnomalyDetectionRequest {
  userId: string;
  keyId: string;
  ipAddress: string;
  endpoint: string;
  timestamp: Date;
}

/**
 * Service for detecting anomalies in API key usage
 * Compares current usage patterns against baseline to identify suspicious activity
 */
export class ApiKeyAlertService {
  /**
   * Main detection method - checks all anomaly types for a request
   * Should be called asynchronously (fire-and-forget) to avoid blocking requests
   */
  static async detectAnomalies(request: AnomalyDetectionRequest, logger?: Logger): Promise<void> {
    const { userId, keyId, ipAddress, endpoint } = request;

    try {
      const apiKey = await userApiKeyRepository.findById(keyId);
      if (!apiKey || apiKey.userId !== userId) {
        logger?.debug('API key not found or user mismatch, skipping anomaly detection', {
          userId,
          keyId,
        });
        return;
      }

      const baseline = apiKey.metadata?.baseline;
      if (!baseline) {
        // No baseline yet - skip detection (not enough historical data)
        logger?.debug('No baseline available for anomaly detection', { userId, keyId });
        return;
      }

      // Check if baseline is stale (older than 7 days)
      const baselineAge = Date.now() - baseline.lastCalculatedAt.getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (baselineAge > sevenDays) {
        logger?.debug('Baseline is stale, skipping anomaly detection', {
          userId,
          keyId,
          baselineAge: baselineAge / (24 * 60 * 60 * 1000), // days
        });
        return;
      }

      const [highRateResult, isNewIP, isUnusualPattern] = await Promise.all([
        this.detectHighRate(userId, keyId, baseline, logger),
        this.detectNewIP(ipAddress, baseline, logger),
        this.detectUnusualPattern(endpoint, baseline, logger),
      ]);

      if (highRateResult.isAnomaly) {
        await this.createHighRateAlert(userId, keyId, baseline, highRateResult.currentRatePerHour, logger);
      }

      if (isNewIP) {
        await this.createNewIPAlert(userId, keyId, ipAddress, baseline, logger);
      }

      if (isUnusualPattern) {
        await this.createUnusualPatternAlert(userId, keyId, endpoint, baseline, logger);
      }
    } catch (error) {
      // Never fail the request due to detection errors
      logger?.warn('Failed to detect anomalies', {
        userId,
        keyId: request.keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Detect if current request rate is abnormally high compared to baseline.
   * Returns the current hourly rate alongside the boolean so callers can reuse it.
   */
  private static async detectHighRate(
    userId: string,
    keyId: string,
    baseline: IUserApiKeyBaseline,
    logger?: Logger
  ): Promise<{ isAnomaly: boolean; currentRatePerHour: number }> {
    try {
      const baselineRate = baseline.avgRequestsPerHour;

      // Skip if baseline is too low (not enough data)
      if (baselineRate < DETECTION_CONFIG.MIN_BASELINE_RATE) {
        logger?.debug('Baseline rate too low for high rate detection', {
          userId,
          keyId,
          baselineRate,
        });
        return { isAnomaly: false, currentRatePerHour: 0 };
      }

      // Get current rate (requests per minute, convert to per hour)
      const currentRatePerMinute = await ApiKeyUsageManager.getRecentRequestsPerMinute(
        userId,
        keyId,
        1 // last 1 minute
      );
      const currentRatePerHour = currentRatePerMinute * 60;

      // Skip if current rate is too low (avoid false positives)
      if (currentRatePerHour < DETECTION_CONFIG.MIN_CURRENT_RATE) {
        return { isAnomaly: false, currentRatePerHour };
      }

      // Check if current rate exceeds threshold (relative or absolute hourly)
      const threshold = baselineRate * DETECTION_CONFIG.HIGH_RATE_MULTIPLIER;
      const relativeAlert = currentRatePerHour > threshold;
      const absoluteAlert = currentRatePerHour > DETECTION_CONFIG.ABSOLUTE_RPH_THRESHOLD;

      // Absolute daily check: catches sustained moderate abuse below the hourly threshold
      // (e.g. 210 RPH x 24h = 5040 req/day exceeds 5000 but is under the 500 RPH cap)
      // Skip the extra DB query if hourly checks already triggered an alert.
      let absoluteDailyAlert = false;
      if (!relativeAlert && !absoluteAlert) {
        const requestsLast24hPerMin = await ApiKeyUsageManager.getRecentRequestsPerMinute(userId, keyId, 1440);
        const requestsLast24h = requestsLast24hPerMin * 1440;
        absoluteDailyAlert = requestsLast24h > DETECTION_CONFIG.ABSOLUTE_RPD_THRESHOLD;
      }

      const isAnomaly = relativeAlert || absoluteAlert || absoluteDailyAlert;

      if (isAnomaly) {
        logger?.warn('High rate anomaly detected', {
          userId,
          keyId,
          currentRate: currentRatePerHour,
          baselineRate,
          threshold,
          multiplier: currentRatePerHour / baselineRate,
          absoluteAlert,
          absoluteDailyAlert,
          relativeAlert,
        });
      }

      return { isAnomaly, currentRatePerHour };
    } catch (error) {
      logger?.warn('Failed to detect high rate anomaly', {
        userId,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { isAnomaly: false, currentRatePerHour: 0 };
    }
  }

  /**
   * Detect if request is from a new IP address not in baseline
   */
  private static detectNewIP(ipAddress: string, baseline: IUserApiKeyBaseline, logger?: Logger): boolean {
    // Skip if IP is whitelisted (localhost, internal)
    if (WHITELIST_IPS.includes(ipAddress)) {
      return false;
    }

    // Skip if baseline has no common IPs yet
    if (!baseline.commonIPs || baseline.commonIPs.length === 0) {
      logger?.debug('No common IPs in baseline, skipping new IP detection');
      return false;
    }

    // Check if IP is in the common IPs list
    const isNewIP = !baseline.commonIPs.includes(ipAddress);

    if (isNewIP) {
      logger?.warn('New IP anomaly detected', {
        ipAddress,
        commonIPs: baseline.commonIPs,
      });
    }

    return isNewIP;
  }

  /**
   * Detect if request is accessing an unusual endpoint pattern
   */
  private static detectUnusualPattern(endpoint: string, baseline: IUserApiKeyBaseline, logger?: Logger): boolean {
    // Skip if baseline has no common endpoints yet
    if (!baseline.commonEndpoints || baseline.commonEndpoints.length === 0) {
      return false;
    }

    // Check if endpoint is in the common endpoints list
    const isCommonEndpoint = baseline.commonEndpoints.includes(endpoint);
    if (isCommonEndpoint) {
      return false; // Not unusual
    }

    // Check if endpoint is sensitive (should always alert on sensitive endpoints)
    const isSensitiveEndpoint = DETECTION_CONFIG.SENSITIVE_ENDPOINTS.some(sensitive => endpoint.startsWith(sensitive));

    if (isSensitiveEndpoint) {
      logger?.warn('Unusual pattern detected (sensitive endpoint)', {
        endpoint,
        commonEndpoints: baseline.commonEndpoints,
      });
      return true;
    }

    // For non-sensitive endpoints, we could be more lenient
    // For now, we'll only alert on sensitive endpoints
    return false;
  }

  /**
   * Create a high_rate alert. Accepts the pre-computed currentRatePerHour from detectHighRate
   * to avoid a redundant DB query.
   */
  private static async createHighRateAlert(
    userId: string,
    keyId: string,
    baseline: IUserApiKeyBaseline,
    currentRatePerHour: number,
    logger?: Logger
  ): Promise<void> {
    try {
      const baselineRate = baseline.avgRequestsPerHour;
      const multiplier = (currentRatePerHour / baselineRate).toFixed(1);

      await apiKeyAlertRepository.createAlert(
        userId,
        keyId,
        'high_rate',
        `API key usage rate is ${multiplier}x higher than normal (${currentRatePerHour.toFixed(
          1
        )} req/hr vs ${baselineRate.toFixed(1)} req/hr baseline)`,
        {
          currentRate: currentRatePerHour,
          baselineRate,
        }
      );

      logger?.info('High rate alert created', { userId, keyId, currentRate: currentRatePerHour, baselineRate });
    } catch (error) {
      logger?.warn('Failed to create high rate alert', {
        userId,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create a new_ip alert
   */
  private static async createNewIPAlert(
    userId: string,
    keyId: string,
    ipAddress: string,
    baseline: IUserApiKeyBaseline,
    logger?: Logger
  ): Promise<void> {
    try {
      await apiKeyAlertRepository.createAlert(
        userId,
        keyId,
        'new_ip',
        `API key used from new IP address: ${ipAddress} (not in known IPs: ${baseline.commonIPs.join(', ')})`,
        {
          ipAddress,
        }
      );

      logger?.info('New IP alert created', { userId, keyId, ipAddress });
    } catch (error) {
      logger?.warn('Failed to create new IP alert', {
        userId,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create an unusual_pattern alert
   */
  private static async createUnusualPatternAlert(
    userId: string,
    keyId: string,
    endpoint: string,
    baseline: IUserApiKeyBaseline,
    logger?: Logger
  ): Promise<void> {
    try {
      await apiKeyAlertRepository.createAlert(
        userId,
        keyId,
        'unusual_pattern',
        `API key accessing unusual endpoint: ${endpoint} (not in common endpoints: ${baseline.commonEndpoints.slice(0, 3).join(', ')}...)`,
        {
          endpoint,
        }
      );

      logger?.info('Unusual pattern alert created', { userId, keyId, endpoint });
    } catch (error) {
      logger?.warn('Failed to create unusual pattern alert', {
        userId,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
