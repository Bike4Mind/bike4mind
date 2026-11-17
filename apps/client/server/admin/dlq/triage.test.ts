import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@server/admin/ai/readiness', () => ({ getAdminAiClassReadiness: h.readiness }));
vi.mock('@server/admin/ai/telemetry', () => ({ recordAdminAiAttempt: h.attempt }));

import { triageDlqMessage, visibleDlqSuggestion } from './triage';

describe('DLQ triage orchestration', () => {
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
});
