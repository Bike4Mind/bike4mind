/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { computeStatusAndScore } from '../wafScan';

/**
 * WAF Scan Scoring Tests
 *
 * These tests validate the WAF security scan scoring algorithm and status computation.
 * The scoring logic is based on severity-weighted deductions from a baseline score of 100.
 *
 * Scoring Model:
 * - Starting score: 100
 * - Critical: -30 points each
 * - High: -20 points each
 * - Medium: -10 points each
 * - Low: -5 points each
 * - Final score: clamped to [0, 100]
 *
 * Status Assignment:
 * - 'fail': critical > 0 OR high > 0
 * - 'warning': medium > 0 OR low > 0 (and no critical/high)
 * - 'pass': no findings
 */

describe('wafScan scoring', () => {
  describe('computeStatusAndScore', () => {
    it('should return perfect score (100) for no findings', () => {
      const result = computeStatusAndScore({ critical: 0, high: 0, medium: 0, low: 0 });

      expect(result.score).toBe(100);
      expect(result.status).toBe('pass');
      expect(result.summary).toContain('No WAF configuration issues detected');
    });

    it('should return "fail" status for critical findings', () => {
      const result = computeStatusAndScore({ critical: 1, high: 0, medium: 0, low: 0 });

      expect(result.status).toBe('fail');
      expect(result.score).toBe(70); // 100 - 30
      expect(result.summary).toContain('1 critical');
    });

    it('should return "fail" status for high findings', () => {
      const result = computeStatusAndScore({ critical: 0, high: 1, medium: 0, low: 0 });

      expect(result.status).toBe('fail');
      expect(result.score).toBe(80); // 100 - 20
      expect(result.summary).toContain('1 high');
    });

    it('should return "warning" status for medium findings', () => {
      const result = computeStatusAndScore({ critical: 0, high: 0, medium: 1, low: 0 });

      expect(result.status).toBe('warning');
      expect(result.score).toBe(90); // 100 - 10
      expect(result.summary).toContain('1 medium');
    });

    it('should return "warning" status for low findings', () => {
      const result = computeStatusAndScore({ critical: 0, high: 0, medium: 0, low: 1 });

      expect(result.status).toBe('warning');
      expect(result.score).toBe(95); // 100 - 5
      expect(result.summary).toContain('1 low');
    });

    it('should prioritize "fail" over "warning" when both exist', () => {
      const result = computeStatusAndScore({ critical: 1, high: 0, medium: 1, low: 1 });

      expect(result.status).toBe('fail');
      expect(result.score).toBe(55); // 100 - 30 - 10 - 5
      expect(result.summary).toContain('1 critical');
      expect(result.summary).toContain('1 medium');
      expect(result.summary).toContain('1 low');
    });

    it('should clamp score to 0 when deductions exceed 100', () => {
      const result = computeStatusAndScore({ critical: 5, high: 3, medium: 2, low: 5 });

      // 100 - (5*30) - (3*20) - (2*10) - (5*5) = 100 - 150 - 60 - 20 - 25 = -155
      expect(result.score).toBe(0);
      expect(result.status).toBe('fail');
    });

    it('should calculate correct score for multiple findings', () => {
      const result = computeStatusAndScore({ critical: 2, high: 1, medium: 3, low: 2 });

      // 100 - (2*30) - (1*20) - (3*10) - (2*5) = 100 - 60 - 20 - 30 - 10 = -20 => 0
      expect(result.score).toBe(0);
      expect(result.status).toBe('fail');
    });

    it('should format summary correctly for single finding type', () => {
      const result = computeStatusAndScore({ critical: 0, high: 3, medium: 0, low: 0 });

      expect(result.summary).toBe('3 high WAF configuration issues detected in the latest scan.');
    });

    it('should format summary correctly for multiple finding types', () => {
      const result = computeStatusAndScore({ critical: 1, high: 2, medium: 3, low: 4 });

      expect(result.summary).toContain('1 critical, 2 high, 3 medium, 4 low');
      expect(result.summary).toContain('WAF configuration issues detected');
    });

    it('should handle zero values in summary (skip zero severities)', () => {
      const result = computeStatusAndScore({ critical: 0, high: 1, medium: 0, low: 2 });

      expect(result.summary).not.toContain('0 critical');
      expect(result.summary).not.toContain('0 medium');
      expect(result.summary).toContain('1 high');
      expect(result.summary).toContain('2 low');
    });

    it('should maintain score between 0 and 100 (boundary test)', () => {
      const testCases = [
        { critical: 0, high: 0, medium: 0, low: 0 }, // 100
        { critical: 0, high: 0, medium: 0, low: 1 }, // 95
        { critical: 0, high: 0, medium: 1, low: 0 }, // 90
        { critical: 0, high: 1, medium: 0, low: 0 }, // 80
        { critical: 1, high: 0, medium: 0, low: 0 }, // 70
        { critical: 3, high: 1, medium: 0, low: 0 }, // 10
        { critical: 4, high: 0, medium: 0, low: 0 }, // -20 => 0
        { critical: 10, high: 10, medium: 10, low: 10 }, // -650 => 0
      ];

      for (const counts of testCases) {
        const result = computeStatusAndScore(counts);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    });

    it('should ensure score is deterministic for same inputs', () => {
      const counts = { critical: 1, high: 2, medium: 3, low: 4 };

      const result1 = computeStatusAndScore(counts);
      const result2 = computeStatusAndScore(counts);

      expect(result1.score).toBe(result2.score);
      expect(result1.status).toBe(result2.status);
      expect(result1.summary).toBe(result2.summary);
    });
  });

  describe('severity weights alignment with design doc', () => {
    it('should match documented severity weights', () => {
      // Validate that the scoring model matches the design specification
      const criticalWeight = 30;
      const highWeight = 20;
      const mediumWeight = 10;
      const lowWeight = 5;

      const testWithCritical = computeStatusAndScore({ critical: 1, high: 0, medium: 0, low: 0 });
      expect(testWithCritical.score).toBe(100 - criticalWeight);

      const testWithHigh = computeStatusAndScore({ critical: 0, high: 1, medium: 0, low: 0 });
      expect(testWithHigh.score).toBe(100 - highWeight);

      const testWithMedium = computeStatusAndScore({ critical: 0, high: 0, medium: 1, low: 0 });
      expect(testWithMedium.score).toBe(100 - mediumWeight);

      const testWithLow = computeStatusAndScore({ critical: 0, high: 0, medium: 0, low: 1 });
      expect(testWithLow.score).toBe(100 - lowWeight);
    });

    it('should match status assignment rules from design', () => {
      // Design: fail if critical > 0 OR high > 0
      expect(computeStatusAndScore({ critical: 1, high: 0, medium: 0, low: 0 }).status).toBe('fail');
      expect(computeStatusAndScore({ critical: 0, high: 1, medium: 0, low: 0 }).status).toBe('fail');
      expect(computeStatusAndScore({ critical: 1, high: 1, medium: 0, low: 0 }).status).toBe('fail');

      // Design: warning if (medium > 0 OR low > 0) AND no critical/high
      expect(computeStatusAndScore({ critical: 0, high: 0, medium: 1, low: 0 }).status).toBe('warning');
      expect(computeStatusAndScore({ critical: 0, high: 0, medium: 0, low: 1 }).status).toBe('warning');
      expect(computeStatusAndScore({ critical: 0, high: 0, medium: 1, low: 1 }).status).toBe('warning');

      // Design: pass if no findings
      expect(computeStatusAndScore({ critical: 0, high: 0, medium: 0, low: 0 }).status).toBe('pass');
    });
  });
});
