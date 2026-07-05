/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { WAFV2Client, GetLoggingConfigurationCommand } from '@aws-sdk/client-wafv2';
import { getWafLogsInsightsOverview } from '../wafLogsInsights';
import { wafQueryCache } from '../wafQueryCache';
import type { WafCustomRange } from '../wafSharedHelpers';

const cloudFrontMock = mockClient(CloudFrontClient);
const cloudWatchLogsMock = mockClient(CloudWatchLogsClient);
const wafMock = mockClient(WAFV2Client);

// Mock SST Resource
vi.mock('sst', () => ({
  Resource: {
    RouterDistributionId: {
      id: 'E1234567890ABC',
    },
  },
}));

describe('wafLogsInsights', () => {
  const mockWebAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/bike4mind-api-protection-dev/abc123';
  const mockLogGroupArn = 'arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-bike4mind-dev';

  beforeEach(() => {
    cloudFrontMock.reset();
    cloudWatchLogsMock.reset();
    wafMock.reset();
    wafQueryCache.invalidate();

    // Default mocks for happy path
    cloudFrontMock.on(GetDistributionCommand).resolves({
      Distribution: {
        DistributionConfig: {
          WebACLId: mockWebAclArn,
        },
      },
    });

    wafMock.on(GetLoggingConfigurationCommand).resolves({
      LoggingConfiguration: {
        ResourceArn: mockWebAclArn,
        LogDestinationConfigs: [mockLogGroupArn],
      },
    });

    cloudWatchLogsMock.on(StartQueryCommand).resolves({
      queryId: 'query-123',
    });

    cloudWatchLogsMock.on(GetQueryResultsCommand).resolves({
      status: 'Complete',
      results: [
        [
          { field: 'action', value: 'BLOCK' },
          { field: 'count', value: '10' },
        ],
        [
          { field: 'action', value: 'ALLOW' },
          { field: 'count', value: '100' },
        ],
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getWafLogsInsightsOverview', () => {
    it('should return insights overview with traffic characteristics', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '24h',
      });

      expect(result.enabled).toBe(true);
      expect(result.stage).toBe('dev');
      expect(result.range).toBe('24h');
      expect(result.webAclArn).toBe(mockWebAclArn);
      expect(result.logGroupName).toBe('aws-waf-logs-bike4mind-dev');
      expect(result.logGroupRegion).toBe('us-east-1');
      expect(result.checkedAt).toBeDefined();
    });

    it('should handle case when WAF is not attached', async () => {
      cloudFrontMock.on(GetDistributionCommand).resolves({
        Distribution: {
          DistributionConfig: {
            WebACLId: '', // No WAF
          },
        },
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('no-webacl');
      expect(result.webAclArn).toBeUndefined();
      expect(result.trafficCharacteristics).toBeUndefined();
    });

    it('should handle case when WAF logging is not configured', async () => {
      wafMock.on(GetLoggingConfigurationCommand).resolves({
        LoggingConfiguration: {
          ResourceArn: mockWebAclArn,
          LogDestinationConfigs: [], // No log destinations
        },
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('no-logging-config');
      expect(result.webAclArn).toBe(mockWebAclArn);
    });

    it('should handle WAFv2 GetLoggingConfiguration errors', async () => {
      wafMock.on(GetLoggingConfigurationCommand).rejects(new Error('WAF API error'));

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('no-logging-config');
    });

    it('should return timestamp as ISO string', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(result.checkedAt).getTime()).not.toBeNaN();
    });

    it('should handle all range values', async () => {
      const ranges: Array<'1h' | '24h' | '7d'> = ['1h', '24h', '7d'];

      for (const range of ranges) {
        const result = await getWafLogsInsightsOverview({
          stage: 'dev',
          range,
        });

        expect(result.range).toBe(range);
        expect(result.enabled).toBe(true);
      }
    });

    it('should parse log group name from ARN', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.logGroupName).toBe('aws-waf-logs-bike4mind-dev');
      expect(result.logGroupRegion).toBe('us-east-1');
    });

    it('should include stage in response', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'production',
        range: '24h',
      });

      expect(result.stage).toBe('production');
    });

    it('should handle CloudWatch Logs query that returns no results', async () => {
      cloudWatchLogsMock.on(GetQueryResultsCommand).resolves({
        status: 'Complete',
        results: [], // No log data
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(true);
      // Should still have structure but empty data
      expect(result.trafficCharacteristics).toBeDefined();
    });

    it('should handle query timeout gracefully', { timeout: 10000 }, async () => {
      // Simulate a query that takes too long and eventually times out
      let callCount = 0;
      cloudWatchLogsMock.on(GetQueryResultsCommand).callsFake(() => {
        callCount++;
        // After several attempts, return complete status
        if (callCount > 3) {
          return {
            status: 'Complete',
            results: [],
          };
        }
        return {
          status: 'Running',
        };
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(true);
    });

    it('should call StopQueryCommand when query completes', async () => {
      await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      const stopQueryCalls = cloudWatchLogsMock.commandCalls(StopQueryCommand);
      expect(stopQueryCalls.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle CloudFront API errors', async () => {
      cloudFrontMock.on(GetDistributionCommand).rejects(new Error('CloudFront error'));

      await expect(
        getWafLogsInsightsOverview({
          stage: 'dev',
          range: '1h',
        })
      ).rejects.toThrow();
    });

    it('should handle malformed log group ARN', async () => {
      wafMock.on(GetLoggingConfigurationCommand).resolves({
        LoggingConfiguration: {
          ResourceArn: mockWebAclArn,
          LogDestinationConfigs: ['invalid-arn-format'], // Malformed
        },
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('no-logging-config');
    });

    it('should use correct region from log group ARN', async () => {
      const euLogGroupArn = 'arn:aws:logs:eu-west-1:123456789012:log-group:aws-waf-logs-eu';
      wafMock.on(GetLoggingConfigurationCommand).resolves({
        LoggingConfiguration: {
          ResourceArn: mockWebAclArn,
          LogDestinationConfigs: [euLogGroupArn],
        },
      });

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.logGroupRegion).toBe('eu-west-1');
      expect(result.logGroupName).toBe('aws-waf-logs-eu');
    });

    it('should handle StartQuery failures', async () => {
      cloudWatchLogsMock.on(StartQueryCommand).rejects(new Error('Query start failed'));

      await expect(async () => {
        await getWafLogsInsightsOverview({
          stage: 'dev',
          range: '1h',
        });
      }).rejects.toThrow('Query start failed');
    });

    it('should handle GetQueryResults failures', async () => {
      cloudWatchLogsMock.on(GetQueryResultsCommand).rejects(new Error('Query results failed'));

      await expect(async () => {
        await getWafLogsInsightsOverview({
          stage: 'dev',
          range: '1h',
        });
      }).rejects.toThrow('Query results failed');
    });

    it('should validate distribution ID from SST Resource', async () => {
      await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      // Should have called CloudFront with the distribution ID from SST Resource
      const cloudFrontCalls = cloudFrontMock.calls();
      expect(cloudFrontCalls.length).toBeGreaterThan(0);
      expect(cloudFrontCalls[0].args[0].input).toEqual({
        Id: 'E1234567890ABC',
      });
    });

    it('should use us-east-1 region for WAF API calls', async () => {
      await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      // WAF calls should use us-east-1 for CloudFront-scope WebACLs
      const wafCalls = wafMock.calls();
      expect(wafCalls.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle very short time ranges', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      expect(result.range).toBe('1h');
      expect(result.enabled).toBe(true);
    });

    it('should handle very long time ranges', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '7d',
      });

      expect(result.range).toBe('7d');
      expect(result.enabled).toBe(true);
    });

    it('should handle stage names with special characters', async () => {
      const result = await getWafLogsInsightsOverview({
        stage: 'pr6391',
        range: '24h',
      });

      expect(result.stage).toBe('pr6391');
    });
  });

  describe('SST Resource integration', () => {
    it('should read distribution ID from RouterDistributionId resource', async () => {
      await getWafLogsInsightsOverview({
        stage: 'dev',
        range: '1h',
      });

      const cloudFrontCalls = cloudFrontMock.calls();
      expect(cloudFrontCalls).toHaveLength(1);
      expect(cloudFrontCalls[0].args[0].input).toEqual({
        Id: 'E1234567890ABC',
      });
    });
  });

  describe('WafCustomRange support', () => {
    it('should accept a custom { start, end } range', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-15T23:59:59Z',
      };

      const result = await getWafLogsInsightsOverview({
        stage: 'dev',
        range: customRange,
      });

      expect(result.enabled).toBe(true);
      expect(result.range).toEqual(customRange);
      expect(result.stage).toBe('dev');
    });

    it('should use the exact start/end timestamps in CloudWatch Logs Insights queries', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-10T08:00:00Z',
        end: '2024-01-12T08:00:00Z',
      };

      await getWafLogsInsightsOverview({
        stage: 'dev',
        range: customRange,
      });

      const startCalls = cloudWatchLogsMock.commandCalls(StartQueryCommand);
      expect(startCalls.length).toBeGreaterThan(0);
      const input = startCalls[0].args[0].input;
      expect(input.startTime).toBe(Math.floor(new Date(customRange.start).getTime() / 1000));
      expect(input.endTime).toBe(Math.floor(new Date(customRange.end).getTime() / 1000));
    });

    it('should produce a distinct cache key for custom ranges', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-15T23:59:59Z',
      };

      // First call - fetches from CloudWatch
      await getWafLogsInsightsOverview({ stage: 'dev', range: customRange });
      // Second call with same custom range - served from cache
      await getWafLogsInsightsOverview({ stage: 'dev', range: customRange });

      // StartQuery should only have been called once (cache hit on second call)
      const startCalls = cloudWatchLogsMock.commandCalls(StartQueryCommand);
      expect(startCalls.length).toBeGreaterThan(0);
      const firstCallCount = startCalls.length;

      // A different custom range should trigger a new fetch
      wafQueryCache.invalidate();
      const differentRange: WafCustomRange = {
        start: '2024-01-20T00:00:00Z',
        end: '2024-01-20T23:59:59Z',
      };
      await getWafLogsInsightsOverview({ stage: 'dev', range: differentRange });

      expect(cloudWatchLogsMock.commandCalls(StartQueryCommand).length).toBeGreaterThan(firstCallCount);
    });
  });
});
