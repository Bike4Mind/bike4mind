import {
  ABUSE_ASSESSMENT_MAX_ACCOUNTS,
  ABUSE_ASSESSMENT_MAX_SIGNALS,
  ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS,
  ABUSE_ASSESSMENT_POLICY_VERSION,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const userIds = Array.from({ length: ABUSE_ASSESSMENT_MAX_ACCOUNTS }, (_, index) =>
  (0x65f0000000000000000000a0n + BigInt(index)).toString(16)
);

const detection = (signalCount: number): ShadowDetectionItem => ({
  id: '65f000000000000000000001',
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: 'burst',
  userIds,
  network: null,
  signals: Array.from({ length: signalCount }, (_, index) => ({
    key: `signal${index}`,
    label: 'Signal',
    observed: index,
    threshold: 1,
  })),
  windowMinutes: 180,
  detectedAt: new Date('2026-11-01T12:00:00Z'),
  verdict: null,
  verdicts: [],
  revision: 0,
});

const loadWith = async (overrides: Record<string, number>) => {
  vi.resetModules();
  vi.doMock('@bike4mind/common', async importActual => ({
    ...(await importActual<typeof import('@bike4mind/common')>()),
    ...overrides,
  }));
  return import('./featureSummary');
};

const buildFull = (module: Awaited<ReturnType<typeof loadWith>>) =>
  module.buildFeatureSummary({ detection: detection(ABUSE_ASSESSMENT_MAX_SIGNALS), accounts: [], group: null });

afterEach(() => {
  vi.doUnmock('@bike4mind/common');
  vi.resetModules();
});

describe('feature summary caps', () => {
  it('copies at most the signal cap and keeps every signal up to it', async () => {
    const { buildFeatureSummary } = await loadWith({});
    const build = (count: number) =>
      buildFeatureSummary({ detection: detection(count), accounts: [], group: null }).detection.signals;
    expect(build(ABUSE_ASSESSMENT_MAX_SIGNALS)).toHaveLength(ABUSE_ASSESSMENT_MAX_SIGNALS);
    expect(build(ABUSE_ASSESSMENT_MAX_SIGNALS + 5)).toHaveLength(ABUSE_ASSESSMENT_MAX_SIGNALS);
  });

  it('keeps a summary exactly at the size cap and trims trailing accounts past it', async () => {
    const full = buildFull(await loadWith({}));
    const fullSize = JSON.stringify(full).length;
    expect(fullSize).toBeLessThanOrEqual(ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS);
    expect(full.accounts).toHaveLength(ABUSE_ASSESSMENT_MAX_ACCOUNTS);

    const kept = buildFull(await loadWith({ ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS: fullSize }));
    expect(kept.accounts).toHaveLength(ABUSE_ASSESSMENT_MAX_ACCOUNTS);
    expect(kept.accountsOmitted).toBe(0);

    const trimmed = buildFull(await loadWith({ ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS: fullSize - 1 }));
    expect(trimmed.accounts).toHaveLength(ABUSE_ASSESSMENT_MAX_ACCOUNTS - 1);
    expect(trimmed.accountsOmitted).toBe(1);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(fullSize - 1);
  });

  it('keys the cache on the policy version', async () => {
    const current = await loadWith({});
    const bumped = await loadWith({ ABUSE_ASSESSMENT_POLICY_VERSION: ABUSE_ASSESSMENT_POLICY_VERSION + 1 });
    expect(current.assessmentCacheKey('a', 'hash', 'gpt-6-luna')).not.toBe(
      bumped.assessmentCacheKey('a', 'hash', 'gpt-6-luna')
    );
  });
});
