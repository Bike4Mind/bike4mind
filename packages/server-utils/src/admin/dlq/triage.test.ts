import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAiSuggestionItem } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  config: vi.fn(),
  find: vi.fn(),
  latest: vi.fn(),
  create: vi.fn(),
  failures: vi.fn(),
  readiness: vi.fn(),
  attempt: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  adminAiSuggestionRepository: { findByKey: h.find, findLatestForEntity: h.latest, createPending: h.create },
  dlqFailureRepository: { findForMessages: h.failures },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(), getSettingsValue: h.config }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getDlqByLabel: () => ({ label: 'fixture', sourceQueue: 'source', replay: 'safe' }),
  getSourceQueueUrl: () => 'https://example.test/source',
}));
vi.mock('../ai/readiness', () => ({ getAdminAiClassReadiness: h.readiness }));
vi.mock('../ai/telemetry', () => ({ recordAdminAiAttempt: h.attempt }));
vi.mock('./triageEvidence', async importOriginal => ({
  ...(await importOriginal<typeof import('./triageEvidence')>()),
  sampleDlqConsumerLogs: vi.fn().mockResolvedValue({ status: 'unavailable', sampledEvents: 0 }),
}));

import { triageDlqMessage, visibleDlqSuggestion } from './triage';
import { sampleDlqConsumerLogs } from './triageEvidence';

describe('DLQ triage orchestration', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    h.config.mockReturnValue({ enabled: true, features: { dlqTriage: { mode: 'recommend' } } });
    h.find.mockResolvedValue(null);
    h.failures.mockResolvedValue([
      {
        category: 'timeout',
        failedAt: new Date('2026-01-01'),
        consumerVersion: 'v1',
        transientFailure: true,
        errorMessage: 'private user text',
      },
    ]);
    h.readiness.mockResolvedValue({ canRecommend: true, canAct: false });
    h.create.mockImplementation(async value => ({ ...value, id: 'suggestion-1', status: 'pending' }));
    h.latest.mockImplementation(async () => h.create.mock.results[0]?.value ?? null);
    vi.mocked(sampleDlqConsumerLogs).mockResolvedValue({ status: 'unavailable', sampledEvents: 0 });
  });
  it('stores one explanation per stable message input and records zero-cost telemetry', async () => {
    const first = await triageDlqMessage('fixture', 'm1');
    expect(first?.verdict).toBe('replay');
    h.find.mockResolvedValue(first);
    await triageDlqMessage('fixture', 'm1');
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.attempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'cached', calls: 0, knownCostUsd: 0 })
    );
    expect(JSON.stringify(h.create.mock.calls)).not.toContain('private user text');
  });
  it('stops all suggestion work when globally disabled or queue off', async () => {
    for (const config of [
      { enabled: false },
      { enabled: true, features: { dlqTriage: { mode: 'recommend' } }, dlqQueueModes: { fixture: 'off' } },
    ]) {
      h.config.mockReturnValue(config);
      expect(await triageDlqMessage('fixture', 'm1')).toBeNull();
    }
    expect(h.failures).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rechecks readiness when a stored suggestion is requested', async () => {
    await triageDlqMessage('fixture', 'm1');
    h.readiness.mockResolvedValue({ canRecommend: false, canAct: false });
    expect(await visibleDlqSuggestion('fixture', 'm1')).toBeNull();
  });
  it.each(['accepted', 'dismissed'] as const)('preserves %s identity through clock and log changes', async status => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-17T12:00:00Z');
    vi.setSystemTime(now);
    h.failures.mockResolvedValue([]);
    const rows = new Map<string, AdminAiSuggestionItem>();
    let latest: AdminAiSuggestionItem | null = null;
    h.find.mockImplementation(async key => rows.get(key.inputHash) ?? null);
    h.create.mockImplementation(async value => {
      const row = { ...value, id: `suggestion-${rows.size}`, status: 'pending' };
      rows.set(value.inputHash, row);
      latest = row;
      return row;
    });
    h.latest.mockImplementation(async () => latest);
    const facts = { sentTimestamp: String(now), retentionSeconds: 3 * 86400, entityPresent: true };
    const first = await triageDlqMessage('fixture', 'm1', facts);
    expect(first).not.toBeNull();
    latest!.status = status;
    for (const [offset, logStatus, expiry] of [
      [2 * 86400000, 'sampled-matches', 'within-24-hours'],
      [4 * 86400000, 'no-sampled-match', 'elapsed'],
    ] as const) {
      vi.setSystemTime(now + offset);
      vi.mocked(sampleDlqConsumerLogs).mockResolvedValue({
        status: logStatus,
        sampledEvents: logStatus === 'sampled-matches' ? 1 : 0,
      });
      const next = await triageDlqMessage('fixture', 'm1', facts);
      expect(next).toMatchObject({ id: first!.id, status, proposedAction: { facts: { expiry: { status: expiry } } } });
    }
    expect(h.create).toHaveBeenCalledOnce();
    expect(rows.size).toBe(1);
  });
  it.each(['accepted', 'dismissed'] as const)(
    'does not supersede %s decisions during a failure-record DB blip',
    async status => {
      const first = await triageDlqMessage('fixture', 'm1');
      h.latest.mockResolvedValue({ ...first, status });
      h.failures.mockRejectedValue(new Error('private database detail'));
      expect(await triageDlqMessage('fixture', 'm1')).toBeNull();
      expect(await visibleDlqSuggestion('fixture', 'm1')).toMatchObject({ id: first!.id, status });
      expect(h.create).toHaveBeenCalledOnce();
    }
  );
  it.each(['pending', 'accepted', 'dismissed'] as const)(
    'reuses %s draft-preview rows with the old hash',
    async status => {
      const first = await triageDlqMessage('fixture', 'm1');
      h.latest.mockResolvedValue({ ...first, inputHash: 'old-volatile-hash', status });
      h.find.mockResolvedValue(null);
      expect(await triageDlqMessage('fixture', 'm1')).toMatchObject({ id: first!.id, status });
      expect(h.create).toHaveBeenCalledOnce();
    }
  );
  it('does not equate genuinely different stable inputs with an old preview row', async () => {
    await triageDlqMessage('fixture', 'm1');
    await triageDlqMessage('fixture', 'm1', { retentionSeconds: 86400 });
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not mistake a failed failure-record lookup for absence', async () => {
    h.failures.mockRejectedValue(new Error('private database detail'));
    const suggestion = await triageDlqMessage('fixture', 'm1');
    expect(suggestion).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
  });
});
