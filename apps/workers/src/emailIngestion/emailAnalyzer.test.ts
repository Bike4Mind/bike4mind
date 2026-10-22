/**
 * Tests for emailAnalyzer Lambda helper functions
 *
 * Tests the utility functions used by the email analyzer queue handler:
 * - calculateLLMCost: Cost calculation for LLM API calls
 * - parseTemperature: Temperature value parsing and validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * Calculate estimated cost for LLM API call
 * Copied from emailAnalyzer.ts for testing
 */
function calculateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
  // Pricing per 1M tokens (as of 2025)
  const pricing: Record<string, { input: number; output: number }> = {
    [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: { input: 0.8, output: 4.0 },
    [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: { input: 3.0, output: 15.0 },
    [ChatModels.CLAUDE_4_OPUS_BEDROCK]: { input: 15.0, output: 75.0 },
    [ChatModels.GPT4o]: { input: 5.0, output: 15.0 },
  };

  const modelPricing = pricing[model] || { input: 3.0, output: 15.0 };

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Safely parse temperature value from AdminSettings
 * Copied from emailAnalyzer.ts for testing
 */
function parseTemperature(value: unknown, logger: Logger): number {
  if (typeof value === 'number') {
    if (value >= 0 && value <= 1) {
      return value;
    }
    logger.warn('Temperature out of valid range [0, 1], using default 0.3', { temperature: value });
    return 0.3;
  }

  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
    logger.warn('Invalid temperature string value, using default 0.3', { temperature: value });
    return 0.3;
  }

  logger.warn('Invalid temperature value type, using default 0.3', { temperature: value });
  return 0.3;
}

describe('emailAnalyzer - Helper Functions', () => {
  describe('calculateLLMCost', () => {
    it('should calculate cost for Claude 4.6 Sonnet (Bedrock) correctly', () => {
      // Pricing: $3/1M input, $15/1M output
      // 500 input, 200 output
      // Expected: (500/1M * $3) + (200/1M * $15) = $0.0015 + $0.003 = $0.0045
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 500, 200);

      expect(cost).toBeCloseTo(0.0045, 6);
    });

    it('should calculate cost for Claude 4.5 Haiku (Bedrock) correctly', () => {
      // Pricing: $0.8/1M input, $4/1M output
      // 1000 input, 500 output
      // Expected: (1000/1M * $0.8) + (500/1M * $4) = $0.0008 + $0.002 = $0.0028
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_5_HAIKU_BEDROCK, 1000, 500);

      expect(cost).toBeCloseTo(0.0028, 6);
    });

    it('should calculate cost for Claude 4 Opus correctly', () => {
      // Pricing: $15/1M input, $75/1M output
      // 1000 input, 500 output
      // Expected: (1000/1M * $15) + (500/1M * $75) = $0.015 + $0.0375 = $0.0525
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_OPUS_BEDROCK, 1000, 500);

      expect(cost).toBeCloseTo(0.0525, 6);
    });

    it('should calculate cost for GPT-4o correctly', () => {
      // Pricing: $5/1M input, $15/1M output
      // 800 input, 400 output
      // Expected: (800/1M * $5) + (400/1M * $15) = $0.004 + $0.006 = $0.01
      const cost = calculateLLMCost(ChatModels.GPT4o, 800, 400);

      expect(cost).toBeCloseTo(0.01, 6);
    });

    it('should use default Sonnet pricing for unknown models', () => {
      // Unknown model should default to Sonnet pricing: $3/1M input, $15/1M output
      // 500 input, 200 output
      // Expected: (500/1M * $3) + (200/1M * $15) = $0.0045
      const cost = calculateLLMCost('unknown-model-id', 500, 200);

      expect(cost).toBeCloseTo(0.0045, 6);
    });

    it('should return zero cost for zero tokens', () => {
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 0, 0);

      expect(cost).toBe(0);
    });

    it('should handle large token counts correctly', () => {
      // Test with 1 million tokens each (exactly $3 + $15 = $18)
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 1_000_000, 1_000_000);

      expect(cost).toBeCloseTo(18, 6);
    });

    it('should have correct precision for small costs', () => {
      // Very small token counts
      // 1 input token, 1 output token
      // Expected: (1/1M * $3) + (1/1M * $15) = $0.000003 + $0.000015 = $0.000018
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 1, 1);

      expect(cost).toBeCloseTo(0.000018, 9);
    });

    it('should calculate asymmetric token usage correctly', () => {
      // Large input, small output (common in analysis tasks)
      // 5000 input, 100 output
      // Expected: (5000/1M * $3) + (100/1M * $15) = $0.015 + $0.0015 = $0.0165
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 5000, 100);

      expect(cost).toBeCloseTo(0.0165, 6);
    });

    it('should calculate costs for input-only tokens', () => {
      // Only input tokens, no output (edge case)
      // 2000 input, 0 output
      // Expected: (2000/1M * $3) + $0 = $0.006
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 2000, 0);

      expect(cost).toBeCloseTo(0.006, 6);
    });

    it('should calculate costs for output-only tokens', () => {
      // No input, only output tokens (edge case)
      // 0 input, 1000 output
      // Expected: $0 + (1000/1M * $15) = $0.015
      const cost = calculateLLMCost(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, 0, 1000);

      expect(cost).toBeCloseTo(0.015, 6);
    });
  });

  describe('parseTemperature', () => {
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = {
        log: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        updateMetadata: vi.fn(),
      } as unknown as Logger;
    });

    it('should accept valid number within range (0.5)', () => {
      const result = parseTemperature(0.5, mockLogger);

      expect(result).toBe(0.5);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid number at lower bound (0)', () => {
      const result = parseTemperature(0, mockLogger);

      expect(result).toBe(0);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid number at upper bound (1)', () => {
      const result = parseTemperature(1, mockLogger);

      expect(result).toBe(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid decimal number (0.7)', () => {
      const result = parseTemperature(0.7, mockLogger);

      expect(result).toBe(0.7);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid string number ("0.5")', () => {
      const result = parseTemperature('0.5', mockLogger);

      expect(result).toBe(0.5);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid string at lower bound ("0")', () => {
      const result = parseTemperature('0', mockLogger);

      expect(result).toBe(0);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid string at upper bound ("1")', () => {
      const result = parseTemperature('1', mockLogger);

      expect(result).toBe(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid string with decimal ("0.0")', () => {
      const result = parseTemperature('0.0', mockLogger);

      expect(result).toBe(0.0);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should accept valid string with decimal ("1.0")', () => {
      const result = parseTemperature('1.0', mockLogger);

      expect(result).toBe(1.0);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should reject number above range (1.5) and return default', () => {
      const result = parseTemperature(1.5, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Temperature out of valid range [0, 1], using default 0.3', {
        temperature: 1.5,
      });
    });

    it('should reject negative number (-0.5) and return default', () => {
      const result = parseTemperature(-0.5, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Temperature out of valid range [0, 1], using default 0.3', {
        temperature: -0.5,
      });
    });

    it('should reject invalid string ("invalid") and return default', () => {
      const result = parseTemperature('invalid', mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature string value, using default 0.3', {
        temperature: 'invalid',
      });
    });

    it('should reject string above range ("1.5") and return default', () => {
      const result = parseTemperature('1.5', mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature string value, using default 0.3', {
        temperature: '1.5',
      });
    });

    it('should reject undefined and return default', () => {
      const result = parseTemperature(undefined, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature value type, using default 0.3', {
        temperature: undefined,
      });
    });

    it('should reject null and return default', () => {
      const result = parseTemperature(null, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature value type, using default 0.3', {
        temperature: null,
      });
    });

    it('should reject NaN and return default', () => {
      const result = parseTemperature(NaN, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Temperature out of valid range [0, 1], using default 0.3', {
        temperature: NaN,
      });
    });

    it('should reject object and return default', () => {
      const result = parseTemperature({ value: 0.5 }, mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature value type, using default 0.3', {
        temperature: { value: 0.5 },
      });
    });

    it('should reject array and return default', () => {
      const result = parseTemperature([0.5], mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature value type, using default 0.3', {
        temperature: [0.5],
      });
    });

    it('should reject empty string and return default', () => {
      const result = parseTemperature('', mockLogger);

      expect(result).toBe(0.3);
      expect(mockLogger.warn).toHaveBeenCalledWith('Invalid temperature string value, using default 0.3', {
        temperature: '',
      });
    });
  });
});
