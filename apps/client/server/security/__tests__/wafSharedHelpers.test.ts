/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  RANGE_MS,
  BIN_BY_RANGE,
  parseIsoTimestamp,
  parseLogGroupInfoFromArn,
  escapeInsightsStringLiteral,
} from '../wafSharedHelpers';

describe('wafSharedHelpers', () => {
  describe('RANGE_MS constant', () => {
    it('should have correct milliseconds for 1h', () => {
      expect(RANGE_MS['1h']).toBe(60 * 60 * 1000);
      expect(RANGE_MS['1h']).toBe(3_600_000);
    });

    it('should have correct milliseconds for 24h', () => {
      expect(RANGE_MS['24h']).toBe(24 * 60 * 60 * 1000);
      expect(RANGE_MS['24h']).toBe(86_400_000);
    });

    it('should have correct milliseconds for 7d', () => {
      expect(RANGE_MS['7d']).toBe(7 * 24 * 60 * 60 * 1000);
      expect(RANGE_MS['7d']).toBe(604_800_000);
    });
  });

  describe('BIN_BY_RANGE constant', () => {
    it('should map ranges to correct bin sizes', () => {
      expect(BIN_BY_RANGE['1h']).toBe('5m');
      expect(BIN_BY_RANGE['24h']).toBe('1h');
      expect(BIN_BY_RANGE['7d']).toBe('6h');
    });
  });

  describe('parseIsoTimestamp', () => {
    it('should parse valid ISO timestamp', () => {
      const input = '2024-01-15T10:30:00Z';
      const result = parseIsoTimestamp(input);
      expect(result).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should parse ISO timestamp with milliseconds', () => {
      const input = '2024-01-15T10:30:00.123Z';
      const result = parseIsoTimestamp(input);
      expect(result).toBe('2024-01-15T10:30:00.123Z');
    });

    it('should parse ISO timestamp without Z suffix', () => {
      const input = '2024-01-15T10:30:00';
      const result = parseIsoTimestamp(input);
      expect(result).toMatch(/2024-01-15T\d{2}:30:00\.\d{3}Z/);
    });

    it('should return null for invalid timestamp', () => {
      expect(parseIsoTimestamp('not-a-date')).toBeNull();
      expect(parseIsoTimestamp('2024-13-01')).toBeNull();
      expect(parseIsoTimestamp('')).toBeNull();
      expect(parseIsoTimestamp('invalid')).toBeNull();
    });

    it('should handle edge case dates', () => {
      expect(parseIsoTimestamp('1970-01-01T00:00:00Z')).toBe('1970-01-01T00:00:00.000Z');
      expect(parseIsoTimestamp('2099-12-31T23:59:59Z')).toBe('2099-12-31T23:59:59.000Z');
    });
  });

  describe('parseLogGroupInfoFromArn', () => {
    it('should parse valid log group ARN', () => {
      const arn = 'arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-mygroup';
      const result = parseLogGroupInfoFromArn(arn);
      expect(result).toEqual({
        region: 'us-east-1',
        name: 'aws-waf-logs-mygroup',
      });
    });

    it('should parse ARN with stream suffix', () => {
      const arn = 'arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-mygroup:*';
      const result = parseLogGroupInfoFromArn(arn);
      expect(result).toEqual({
        region: 'us-east-1',
        name: 'aws-waf-logs-mygroup',
      });
    });

    it('should parse ARN with different regions', () => {
      const arnUsWest = 'arn:aws:logs:us-west-2:123456789012:log-group:my-logs';
      expect(parseLogGroupInfoFromArn(arnUsWest)).toEqual({
        region: 'us-west-2',
        name: 'my-logs',
      });

      const arnEuWest = 'arn:aws:logs:eu-west-1:123456789012:log-group:eu-logs';
      expect(parseLogGroupInfoFromArn(arnEuWest)).toEqual({
        region: 'eu-west-1',
        name: 'eu-logs',
      });
    });

    it('should parse ARN with log group name containing hyphens', () => {
      const arn = 'arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-bike4mind-prod';
      const result = parseLogGroupInfoFromArn(arn);
      expect(result).toEqual({
        region: 'us-east-1',
        name: 'aws-waf-logs-bike4mind-prod',
      });
    });

    it('should return null for invalid ARN format', () => {
      expect(parseLogGroupInfoFromArn('not-an-arn')).toBeNull();
      expect(parseLogGroupInfoFromArn('arn:aws:s3:::bucket')).toBeNull();
      expect(parseLogGroupInfoFromArn('')).toBeNull();
    });

    it('should return null for malformed log group ARN', () => {
      // Missing log-group prefix
      expect(parseLogGroupInfoFromArn('arn:aws:logs:us-east-1:123456789012:my-logs')).toBeNull();

      // Missing region
      expect(parseLogGroupInfoFromArn('arn:aws:logs::123456789012:log-group:my-logs')).toBeNull();

      // Missing account ID
      expect(parseLogGroupInfoFromArn('arn:aws:logs:us-east-1::log-group:my-logs')).toBeNull();
    });

    it('should handle log group names with forward slashes', () => {
      const arn = 'arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-function';
      const result = parseLogGroupInfoFromArn(arn);
      expect(result).toEqual({
        region: 'us-east-1',
        name: '/aws/lambda/my-function',
      });
    });
  });

  describe('escapeInsightsStringLiteral', () => {
    it('should escape double quotes', () => {
      expect(escapeInsightsStringLiteral('rule"with"quotes')).toBe('rule\\"with\\"quotes');
    });

    it('should escape backslashes', () => {
      expect(escapeInsightsStringLiteral('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('should escape both backslashes and quotes', () => {
      expect(escapeInsightsStringLiteral('rule"with\\special')).toBe('rule\\"with\\\\special');
    });

    it('should handle strings without special characters', () => {
      expect(escapeInsightsStringLiteral('normal-rule-name')).toBe('normal-rule-name');
      expect(escapeInsightsStringLiteral('AWSManagedRulesCommonRuleSet')).toBe('AWSManagedRulesCommonRuleSet');
    });

    it('should handle empty string', () => {
      expect(escapeInsightsStringLiteral('')).toBe('');
    });

    it('should handle strings with only special characters', () => {
      expect(escapeInsightsStringLiteral('\\\\')).toBe('\\\\\\\\');
      expect(escapeInsightsStringLiteral('""')).toBe('\\"\\"');
    });

    it('should preserve other characters', () => {
      expect(escapeInsightsStringLiteral('rule-with-123-numbers')).toBe('rule-with-123-numbers');
      expect(escapeInsightsStringLiteral('rule_with_underscores')).toBe('rule_with_underscores');
      expect(escapeInsightsStringLiteral('rule:with:colons')).toBe('rule:with:colons');
    });

    it('should handle realistic WAF rule names', () => {
      const ruleName = 'AWSManagedRulesCommonRuleSet-RuleGroup-1';
      expect(escapeInsightsStringLiteral(ruleName)).toBe(ruleName);

      const ruleWithQuotes = 'Rule "Cross-Site Scripting"';
      expect(escapeInsightsStringLiteral(ruleWithQuotes)).toBe('Rule \\"Cross-Site Scripting\\"');
    });

    it('should handle edge case: consecutive special characters', () => {
      expect(escapeInsightsStringLiteral('\\\"\\\\')).toBe('\\\\\\\"\\\\\\\\');
    });
  });

  describe('Type safety', () => {
    it('should have correct TypeScript types for RANGE_MS keys', () => {
      const keys: ('1h' | '24h' | '7d')[] = ['1h', '24h', '7d'];
      keys.forEach(key => {
        expect(RANGE_MS[key]).toBeDefined();
        expect(typeof RANGE_MS[key]).toBe('number');
      });
    });

    it('should have correct TypeScript types for BIN_BY_RANGE keys', () => {
      const keys: ('1h' | '24h' | '7d')[] = ['1h', '24h', '7d'];
      keys.forEach(key => {
        expect(BIN_BY_RANGE[key]).toBeDefined();
        expect(typeof BIN_BY_RANGE[key]).toBe('string');
      });
    });
  });
});
