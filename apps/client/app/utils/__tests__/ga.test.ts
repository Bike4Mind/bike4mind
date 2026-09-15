import { describe, it, expect } from 'vitest';
import { buildGADashboardUrl } from '../ga';

describe('buildGADashboardUrl', () => {
  it('builds URL from properties/ prefixed ID', () => {
    expect(buildGADashboardUrl('properties/123456789')).toBe(
      'https://analytics.google.com/analytics/web/#/p123456789/reports/reportinghub'
    );
  });

  it('builds URL from bare numeric ID', () => {
    expect(buildGADashboardUrl('123456789')).toBe(
      'https://analytics.google.com/analytics/web/#/p123456789/reports/reportinghub'
    );
  });

  it('returns null for empty string', () => {
    expect(buildGADashboardUrl('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(buildGADashboardUrl(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(buildGADashboardUrl(null)).toBeNull();
  });

  it('returns null for non-numeric junk', () => {
    expect(buildGADashboardUrl('foo')).toBeNull();
  });

  it('returns null for javascript: scheme attempt', () => {
    expect(buildGADashboardUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for properties/ prefix with non-numeric suffix', () => {
    expect(buildGADashboardUrl('properties/abc')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(buildGADashboardUrl('  123456789  ')).toBe(
      'https://analytics.google.com/analytics/web/#/p123456789/reports/reportinghub'
    );
  });

  it('trims whitespace with properties/ prefix', () => {
    expect(buildGADashboardUrl('  properties/123456789  ')).toBe(
      'https://analytics.google.com/analytics/web/#/p123456789/reports/reportinghub'
    );
  });
});
