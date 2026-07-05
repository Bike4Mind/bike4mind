import { apiKeyUsageLogRepository } from '@bike4mind/database/auth';
import { IUserApiKeyBaseline } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export interface LogApiKeyUsageParams {
  keyId: string;
  userId: string;
  ipAddress: string;
  endpoint: string;
  method: string;
  responseTime: number;
  statusCode: number;
  logger?: Logger;
}

/**
 * Service for logging API key usage
 * All operations are user-scoped for security
 */
export class ApiKeyUsageManager {
  /**
   * Log API key usage to the database
   * This is called after each API request authenticated with an API key
   */
  static async logUsage(params: LogApiKeyUsageParams): Promise<void> {
    const { keyId, userId, ipAddress, endpoint, method, responseTime, statusCode, logger } = params;

    try {
      logger?.debug('Logging API key usage', {
        keyId,
        userId,
        endpoint,
        method,
        responseTime,
        statusCode,
      });

      const logEntry = await apiKeyUsageLogRepository.create({
        keyId,
        userId, // User-scoped
        timestamp: new Date(),
        ipAddress,
        endpoint,
        method,
        responseTime,
        statusCode,
      });

      logger?.debug('API key usage logged successfully', {
        logId: logEntry.id,
        keyId,
        userId,
        endpoint,
      });
    } catch (error) {
      // Never fail the request due to logging errors
      logger?.warn('Failed to log API key usage', {
        keyId,
        userId,
        endpoint,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Get usage stats for a user's API key within a time range
   */
  static async getUsageStats(
    userId: string,
    keyId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    totalRequests: number;
    avgResponseTime: number;
    uniqueIPs: string[];
    requestsPerMinute: number;
  }> {
    return apiKeyUsageLogRepository.getUsageStats(userId, keyId, startDate, endDate);
  }

  /**
   * Get recent requests per minute for a user's API key
   */
  static async getRecentRequestsPerMinute(userId: string, keyId: string, minutes = 1): Promise<number> {
    return apiKeyUsageLogRepository.getRecentRequestsPerMinute(userId, keyId, minutes);
  }

  /**
   * Get usage logs for a user's API key
   */
  static async getUsageLogs(userId: string, keyId: string, limit = 100) {
    return apiKeyUsageLogRepository.findByUserIdAndKeyId(userId, keyId, limit);
  }

  /**
   * Calculate baseline usage patterns for a user's API key
   * Analyzes the last 30 days of usage logs to establish normal patterns
   */
  static async calculateBaseline(userId: string, keyId: string, logger?: Logger): Promise<IUserApiKeyBaseline | null> {
    try {
      // Get logs from last 30 days
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

      logger?.debug('Calculating baseline', { userId, keyId, startDate, endDate });

      // Get all logs in the time range (we need all of them for accurate baseline)
      const logs = await apiKeyUsageLogRepository.findByUserIdAndKeyIdInDateRange(userId, keyId, startDate, endDate);

      if (logs.length === 0) {
        logger?.debug('No logs found for baseline calculation', { userId, keyId });
        return null; // No baseline if no usage history
      }

      const daysInRange = Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const avgRequestsPerDay = logs.length / daysInRange;
      const avgRequestsPerHour = avgRequestsPerDay / 24;

      const avgResponseTime = logs.reduce((sum, log) => sum + log.responseTime, 0) / logs.length;

      // Get most common IPs (top 5)
      const ipCounts = new Map<string, number>();
      logs.forEach(log => {
        ipCounts.set(log.ipAddress, (ipCounts.get(log.ipAddress) || 0) + 1);
      });
      const commonIPs = Array.from(ipCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ip]) => ip);

      // Get most common endpoints (top 10)
      const endpointCounts = new Map<string, number>();
      logs.forEach(log => {
        endpointCounts.set(log.endpoint, (endpointCounts.get(log.endpoint) || 0) + 1);
      });
      const commonEndpoints = Array.from(endpointCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([endpoint]) => endpoint);

      // Calculate peak hours (hours of day with most requests, 0-23)
      const hourCounts = new Map<number, number>();
      logs.forEach(log => {
        const hour = new Date(log.timestamp).getUTCHours();
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
      });
      // Get top 3 peak hours
      const peakHours = Array.from(hourCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([hour]) => hour)
        .sort((a, b) => a - b); // Sort ascending for readability

      const baseline: IUserApiKeyBaseline = {
        avgRequestsPerHour: Math.round(avgRequestsPerHour * 100) / 100, // Round to 2 decimals
        avgRequestsPerDay: Math.round(avgRequestsPerDay * 100) / 100,
        commonIPs,
        commonEndpoints,
        avgResponseTime: Math.round(avgResponseTime),
        peakHours,
        lastCalculatedAt: new Date(),
      };

      logger?.debug('Baseline calculated', {
        userId,
        keyId,
        baseline: {
          ...baseline,
          totalLogsAnalyzed: logs.length,
        },
      });

      return baseline;
    } catch (error) {
      logger?.error('Failed to calculate baseline', {
        userId,
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
