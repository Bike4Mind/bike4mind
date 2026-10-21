import { describe, expect, it } from 'vitest';
import { FleetUsageExportQuerySchema, FleetUsageExportRowSchema, FleetUsageExportSchema } from './fleetUsageExport';

const row = {
  userId: 'actor',
  email: null,
  ownerId: 'owner',
  ownerType: 'Organization',
  provider: 'provider',
  model: 'model',
  source: 'desktop',
  settledBasis: 'provider',
  status: 'ok',
  inputTokens: 10,
  outputTokens: 2,
  providerInputTokens: 9,
  providerOutputTokens: null,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  costUsd: 0.01,
  creditsCharged: 2,
  writtenOffCredits: 0,
  requests: 1,
};

describe('Fleet daily snapshot contract', () => {
  it('accepts inclusive ranges up to 31 days and real leap days', () => {
    expect(FleetUsageExportQuerySchema.parse({ from: '2026-01-01', to: '2026-01-31' })).toBeTruthy();
    expect(FleetUsageExportQuerySchema.parse({ from: '2024-02-29', to: '2024-02-29' })).toBeTruthy();
  });
  it('rejects impossible dates, reversed/oversized ranges, repeated and scope-selecting query params', () => {
    for (const query of [
      { from: '2026-02-29', to: '2026-03-01' },
      { from: '2026-01-02', to: '2026-01-01' },
      { from: '2026-01-01', to: '2026-02-01' },
      { from: ['2026-01-01'], to: '2026-01-01' },
      { from: '2026-01-01', to: '2026-01-01', ownerId: 'other' },
    ]) {
      expect(FleetUsageExportQuerySchema.safeParse(query).success).toBe(false);
    }
  });
  it('bounds every counter and excludes content fields', () => {
    expect(FleetUsageExportRowSchema.safeParse(row).success).toBe(true);
    for (const field of [
      'inputTokens',
      'outputTokens',
      'providerInputTokens',
      'providerOutputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
      'creditsCharged',
      'writtenOffCredits',
      'requests',
    ]) {
      for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(FleetUsageExportRowSchema.safeParse({ ...row, [field]: value }).success).toBe(false);
      }
    }
    expect(FleetUsageExportRowSchema.safeParse({ ...row, prompt: 'not exported' }).success).toBe(false);
  });
  it('requires all days including empty days in exact order', () => {
    const snapshot = {
      version: 1,
      from: '2026-01-01',
      to: '2026-01-02',
      generatedAt: new Date().toISOString(),
      days: [
        { date: '2026-01-01', rows: [row] },
        { date: '2026-01-02', rows: [] },
      ],
    };
    expect(FleetUsageExportSchema.safeParse(snapshot).success).toBe(true);
    expect(FleetUsageExportSchema.safeParse({ ...snapshot, days: snapshot.days.slice(1) }).success).toBe(false);
    expect(FleetUsageExportSchema.safeParse({ ...snapshot, days: [...snapshot.days].reverse() }).success).toBe(false);
  });
});
