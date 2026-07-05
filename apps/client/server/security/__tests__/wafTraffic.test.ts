/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { resolveDefaultPeriod, getWafTrafficOverview, type WafTrafficRange } from '../wafTraffic';
import type { WafCustomRange } from '../wafSharedHelpers';
import { wafQueryCache } from '../wafQueryCache';

const cloudFrontMock = mockClient(CloudFrontClient);
const cloudWatchMock = mockClient(CloudWatchClient);

// Mock SST Resource
vi.mock('sst', () => ({
  Resource: {
    RouterDistributionId: {
      id: 'E1234567890ABC',
    },
  },
}));

const mockDistributionId = 'E1234567890ABC';
const mockWebAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/bike4mind-api-protection-dev/abc123';

describe('wafTraffic', () => {
  beforeEach(() => {
    cloudFrontMock.reset();
    cloudWatchMock.reset();
    wafQueryCache.invalidate();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveDefaultPeriod', () => {
    it('should return 1m for 1h range', () => {
      expect(resolveDefaultPeriod('1h')).toBe('1m');
    });

    it('should return 5m for 24h range', () => {
      expect(resolveDefaultPeriod('24h')).toBe('5m');
    });

    it('should return 1h for 7d range', () => {
      expect(resolveDefaultPeriod('7d')).toBe('1h');
    });

    it('should handle all valid range values', () => {
      const ranges: WafTrafficRange[] = ['1h', '24h', '7d'];
      ranges.forEach(range => {
        const period = resolveDefaultPeriod(range);
        expect(['1m', '5m', '1h']).toContain(period);
      });
    });

    it('should return 1m for custom range under 2 hours', () => {
      const range: WafCustomRange = {
        start: '2024-01-15T10:00:00Z',
        end: '2024-01-15T11:30:00Z', // 1.5 hours
      };
      expect(resolveDefaultPeriod(range)).toBe('1m');
    });

    it('should return 5m for custom range between 2 and 48 hours', () => {
      const range: WafCustomRange = {
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-16T00:00:00Z', // 24 hours
      };
      expect(resolveDefaultPeriod(range)).toBe('5m');
    });

    it('should return 1h for custom range over 48 hours', () => {
      const range: WafCustomRange = {
        start: '2024-01-10T00:00:00Z',
        end: '2024-01-17T00:00:00Z', // 7 days
      };
      expect(resolveDefaultPeriod(range)).toBe('1h');
    });
  });

  describe('getWafTrafficOverview', () => {
    beforeEach(() => {
      // Mock CloudFront GetDistribution
      cloudFrontMock.on(GetDistributionCommand).resolves({
        Distribution: {
          DistributionConfig: {
            WebACLId: mockWebAclArn,
          },
        },
      });

      // Mock CloudWatch GetMetricData
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          {
            Id: 'allowedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T11:00:00Z')],
            Values: [100, 150],
            StatusCode: 'Complete',
          },
          {
            Id: 'blockedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T11:00:00Z')],
            Values: [10, 15],
            StatusCode: 'Complete',
          },
          {
            Id: 'countedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T11:00:00Z')],
            Values: [5, 8],
            StatusCode: 'Complete',
          },
          {
            Id: 'captchaA',
            Timestamps: [],
            Values: [],
            StatusCode: 'Complete',
          },
          {
            Id: 'challengeA',
            Timestamps: [],
            Values: [],
            StatusCode: 'Complete',
          },
        ],
      });

      // Mock CloudWatch ListMetrics
      cloudWatchMock.on(ListMetricsCommand).resolves({
        Metrics: [
          {
            MetricName: 'BlockedRequests',
            Dimensions: [
              { Name: 'WebACL', Value: 'bike4mind-api-protection-dev' },
              { Name: 'Region', Value: 'us-east-1' },
            ],
          },
        ],
      });
    });

    it('should return WAF traffic overview with metrics', async () => {
      const result = await getWafTrafficOverview({
        stage: 'pr6391',
        range: '24h',
        period: '5m',
        includeRules: false,
      });

      expect(result.enabled).toBe(true);
      expect(result.stage).toBe('pr6391');
      expect(result.range).toBe('24h');
      expect(result.period).toBe('5m');
      expect(result.distributionId).toBe(mockDistributionId);
      expect(result.webAclArn).toBe(mockWebAclArn);
      expect(result.checkedAt).toBeDefined();
    });

    it('should calculate correct traffic totals', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '24h',
        period: '5m',
        includeRules: false,
      });

      expect(result.totals).toBeDefined();
      expect(result.totals!.allowed).toBe(250); // 100 + 150
      expect(result.totals!.blocked).toBe(25); // 10 + 15
      expect(result.totals!.counted).toBe(13); // 5 + 8
      expect(result.totals!.blockRate).toBeGreaterThan(0);
      expect(result.totals!.blockRate).toBeLessThan(1);
    });

    it('should return time series data', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '24h',
        period: '5m',
        includeRules: false,
      });

      expect(result.series).toBeDefined();
      expect(result.series!.timestamps).toHaveLength(2);
      expect(result.series!.allowed).toEqual([100, 150]);
      expect(result.series!.blocked).toEqual([10, 15]);
      expect(result.series!.counted).toEqual([5, 8]);
    });

    it('should handle WAF not enabled case', async () => {
      cloudFrontMock.on(GetDistributionCommand).resolves({
        Distribution: {
          DistributionConfig: {
            WebACLId: '', // No WAF attached
          },
        },
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.enabled).toBe(false);
      expect(result.totals).toBeUndefined();
      expect(result.series).toBeUndefined();
    });

    it('should use custom period when provided', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '24h',
        period: '1h',
        includeRules: false,
      });

      expect(result.period).toBe('1h');
    });

    it('should handle CloudFront API errors gracefully', async () => {
      cloudFrontMock.on(GetDistributionCommand).rejects(new Error('CloudFront API error'));

      await expect(
        getWafTrafficOverview({
          stage: 'dev',
          range: '1h',
          period: '1m',
          includeRules: false,
        })
      ).rejects.toThrow();
    });

    it('should handle empty metric results', async () => {
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.totals).toBeDefined();
      expect(result.totals!.allowed).toBe(0);
      expect(result.totals!.blocked).toBe(0);
      expect(result.totals!.counted).toBe(0);
    });

    it('should calculate blockRate as 0 when no requests', async () => {
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          { Id: 'allowedA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'blockedA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'countedA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'captchaA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'challengeA', Timestamps: [], Values: [], StatusCode: 'Complete' },
        ],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.totals!.blockRate).toBe(0);
    });

    it('should include stage information', async () => {
      const result = await getWafTrafficOverview({
        stage: 'production',
        range: '24h',
        period: '5m',
        includeRules: false,
      });

      expect(result.stage).toBe('production');
      expect(typeof result.stage).toBe('string');
    });

    it('should handle different range values correctly', async () => {
      const testCases: Array<{ range: WafTrafficRange; period: '1m' | '5m' | '1h' }> = [
        { range: '1h', period: '1m' },
        { range: '24h', period: '5m' },
        { range: '7d', period: '1h' },
      ];

      for (const { range, period } of testCases) {
        const result = await getWafTrafficOverview({
          stage: 'dev',
          range,
          period,
          includeRules: false,
        });

        expect(result.range).toBe(range);
        expect(result.period).toBe(period);
      }
    });

    it('should include debug info when debug flag is true', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
        debug: true,
      });

      expect(result.debug).toBeDefined();
      expect(result.debug).toHaveProperty('webAclName');
      expect(result.debug).toHaveProperty('picked');
    });

    it('should not include debug info when debug flag is false', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
        debug: false,
      });

      expect(result.debug).toBeUndefined();
    });

    it('should handle partial metric data (some metrics empty)', async () => {
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          {
            Id: 'allowedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [100],
            StatusCode: 'Complete',
          },
          {
            Id: 'blockedA',
            Timestamps: [], // Empty
            Values: [],
            StatusCode: 'Complete',
          },
          {
            Id: 'countedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [5],
            StatusCode: 'Complete',
          },
        ],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.totals!.allowed).toBe(100);
      expect(result.totals!.blocked).toBe(0);
      expect(result.totals!.counted).toBe(5);
    });

    it('should handle metrics with misaligned timestamps', async () => {
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          {
            Id: 'allowedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z'), new Date('2024-01-15T11:00:00Z')],
            Values: [100, 150],
            StatusCode: 'Complete',
          },
          {
            Id: 'blockedA',
            Timestamps: [new Date('2024-01-15T10:30:00Z')], // Different timestamps
            Values: [10],
            StatusCode: 'Complete',
          },
        ],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      // Should union timestamps and fill missing values with 0
      expect(result.series!.timestamps.length).toBeGreaterThan(0);
      expect(result.totals!.allowed).toBe(250);
      expect(result.totals!.blocked).toBe(10);
    });

    it('should parse WebACL name from ARN correctly', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
        debug: true,
      });

      expect(result.debug!.webAclName).toBe('bike4mind-api-protection-dev');
    });

    it('should handle captcha and challenge metrics when present', async () => {
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          {
            Id: 'allowedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [100],
            StatusCode: 'Complete',
          },
          {
            Id: 'blockedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [10],
            StatusCode: 'Complete',
          },
          {
            Id: 'countedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [5],
            StatusCode: 'Complete',
          },
          {
            Id: 'captchaA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [3],
            StatusCode: 'Complete',
          },
          {
            Id: 'challengeA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [2],
            StatusCode: 'Complete',
          },
        ],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.totals!.captcha).toBe(3);
      expect(result.totals!.challenge).toBe(2);
      expect(result.series!.captcha).toEqual([3]);
      expect(result.series!.challenge).toEqual([2]);
    });

    it('should return timestamp as ISO string', async () => {
      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(result.checkedAt).getTime()).not.toBeNaN();
    });
  });

  describe('SST Resource integration', () => {
    it('should read distribution ID from SST Resource', async () => {
      cloudFrontMock.on(GetDistributionCommand).resolves({
        Distribution: {
          DistributionConfig: {
            WebACLId: mockWebAclArn,
          },
        },
      });

      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [],
      });

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: '1h',
        period: '1m',
        includeRules: false,
      });

      expect(result.distributionId).toBe('E1234567890ABC');
      expect(cloudFrontMock.calls()).toHaveLength(1);
      expect(cloudFrontMock.call(0).args[0].input).toEqual({
        Id: 'E1234567890ABC',
      });
    });
  });

  describe('WafCustomRange support', () => {
    beforeEach(() => {
      cloudFrontMock.on(GetDistributionCommand).resolves({
        Distribution: {
          DistributionConfig: { WebACLId: mockWebAclArn },
        },
      });
      cloudWatchMock.on(GetMetricDataCommand).resolves({
        MetricDataResults: [
          {
            Id: 'allowedA',
            Timestamps: [new Date('2024-01-15T10:00:00Z')],
            Values: [100],
            StatusCode: 'Complete',
          },
          { Id: 'blockedA', Timestamps: [new Date('2024-01-15T10:00:00Z')], Values: [10], StatusCode: 'Complete' },
          { Id: 'countedA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'captchaA', Timestamps: [], Values: [], StatusCode: 'Complete' },
          { Id: 'challengeA', Timestamps: [], Values: [], StatusCode: 'Complete' },
        ],
      });
      cloudWatchMock.on(ListMetricsCommand).resolves({ Metrics: [] });
    });

    it('should accept a custom { start, end } range', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-15T23:59:59Z',
      };

      const result = await getWafTrafficOverview({
        stage: 'dev',
        range: customRange,
        period: '5m',
        includeRules: false,
      });

      expect(result.enabled).toBe(true);
      expect(result.range).toEqual(customRange);
      expect(result.totals).toBeDefined();
      expect(result.totals!.allowed).toBe(100);
      expect(result.totals!.blocked).toBe(10);
    });

    it('should use the exact start/end timestamps supplied in the custom range', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-10T08:00:00Z',
        end: '2024-01-12T08:00:00Z',
      };

      await getWafTrafficOverview({
        stage: 'dev',
        range: customRange,
        period: '1h',
        includeRules: false,
      });

      const calls = cloudWatchMock.commandCalls(GetMetricDataCommand);
      expect(calls.length).toBeGreaterThan(0);
      const input = calls[0].args[0].input;
      expect(input.StartTime?.getTime()).toBe(new Date(customRange.start).getTime());
      expect(input.EndTime?.getTime()).toBe(new Date(customRange.end).getTime());
    });

    it('should produce a distinct cache key for custom ranges', async () => {
      const customRange: WafCustomRange = {
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-15T23:59:59Z',
      };

      // First call - fetches from CloudWatch
      await getWafTrafficOverview({ stage: 'dev', range: customRange, period: '5m', includeRules: false });
      // Second call with same custom range - served from cache
      await getWafTrafficOverview({ stage: 'dev', range: customRange, period: '5m', includeRules: false });

      // CloudWatch should only have been called once
      const metricCalls = cloudWatchMock.commandCalls(GetMetricDataCommand);
      expect(metricCalls).toHaveLength(1);
    });
  });
});
