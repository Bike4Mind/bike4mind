import { describe, expect, it } from 'vitest';
import { shadowDetectionSignalSchema } from '@bike4mind/common';

import type { ProbeActor, ProbeSignalCounts } from './apiProbeScoring';
import { API_PROBE_POLICY_VERSION, buildApiProbeShadowDetection } from './apiProbeShadowDetections';

const counts = (overrides: Partial<ProbeSignalCounts> = {}): ProbeSignalCounts => ({
  refusedFetch: 0,
  webhookSignature: 0,
  invalidId: 0,
  ingestTokenRefused: 0,
  adminDenied: 0,
  denied: 0,
  notFound: 0,
  ...overrides,
});

const actor = (overrides: Partial<ProbeActor> = {}): ProbeActor => ({
  ips: ['203.0.113.10'],
  userIds: ['user-a'],
  score: 46,
  counts: counts({ refusedFetch: 3, adminDenied: 6 }),
  userScores: { 'user-a': 46 },
  distinctPaths: 14,
  samplePaths: ['/api/admin/users'],
  ...overrides,
});

const window = { start: new Date('2026-10-30T11:45:00Z'), end: new Date('2026-10-30T12:00:00Z') };

const build = (input: Omit<Parameters<typeof buildApiProbeShadowDetection>[0], 'newUserIds'>, newUserIds?: string[]) =>
  buildApiProbeShadowDetection({ ...input, newUserIds: new Set(newUserIds ?? input.actor.userIds) });

describe('buildApiProbeShadowDetection', () => {
  it('would contain the signed-in accounts and records the observed signals', () => {
    const detection = build({ actor: actor(), threshold: 25, window });

    if (!detection) throw new Error('expected a detection');
    expect(detection).toMatchObject({
      detector: 'apiProbe',
      policyVersion: API_PROBE_POLICY_VERSION,
      wouldAction: 'contain',
      userIds: ['user-a'],
      network: { ip: '203.0.113.10', asn: null },
      windowMinutes: 15,
      detectedAt: window.end,
    });
    expect(detection.summary).toContain('score 46 in 15 minutes');
    expect(detection.signals.map(signal => signal.key)).toEqual([
      'score',
      'ipCount',
      'linkedAccounts',
      'refusedFetch',
      'adminDenied',
    ]);
    expect(detection.signals.find(signal => signal.key === 'score')).toMatchObject({ observed: 46, threshold: 25 });
    expect(detection.signals.find(signal => signal.key === 'adminDenied')).toMatchObject({ observed: 6, threshold: 5 });
    expect(detection.signals.find(signal => signal.key === 'adminDenied')?.label).toContain('actor total');
    expect(detection.signals.find(signal => signal.key === 'refusedFetch')?.label).not.toContain('actor total');
    for (const signal of detection.signals) expect(shadowDetectionSignalSchema.parse(signal)).toEqual(signal);
  });

  it('leaves out a linked account that did not score the threshold on its own', () => {
    const detection = build({
      actor: actor({ userIds: ['user-a', 'user-cotenant'], userScores: { 'user-a': 44, 'user-cotenant': 2 } }),
      threshold: 25,
      window,
    });
    expect(detection?.userIds).toEqual(['user-a']);
    expect(detection?.summary).toContain('1 of 2 linked account(s)');
  });

  it('leaves out an account that already has a detection inside the dedupe window', () => {
    const scores = { 'user-a': 40, 'user-b': 40 };
    const linked = actor({ userIds: ['user-a', 'user-b'], userScores: scores });
    expect(build({ actor: linked, threshold: 25, window }, ['user-b'])?.userIds).toEqual(['user-b']);
    expect(build({ actor: linked, threshold: 25, window }, [])).toBeNull();
  });

  it('records nothing when no account scored the threshold on its own', () => {
    expect(build({ actor: actor({ userIds: [], userScores: {} }), threshold: 25, window })).toBeNull();
    expect(
      build({
        actor: actor({ userIds: ['user-a', 'user-b'], userScores: { 'user-a': 20, 'user-b': 20 } }),
        threshold: 25,
        window,
      })
    ).toBeNull();
  });

  it('leaves the network empty when the actor used several IPs', () => {
    const detection = build({
      actor: actor({ ips: ['203.0.113.10', '198.51.100.7'] }),
      threshold: 25,
      window,
    });
    expect(detection?.network).toBeNull();
    expect(detection?.signals.find(signal => signal.key === 'ipCount')?.observed).toBe(2);
  });
});
