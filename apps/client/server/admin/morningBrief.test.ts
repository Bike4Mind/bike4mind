import { describe, it, expect, vi } from 'vitest';
import type { AdminMorningBrief } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({
  AdminAiSuggestionModel: {},
  adminMorningBriefRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlackWithOutcome: vi.fn() }));
vi.mock('./actionCounts', () => ({ computeAdminActionCounts: vi.fn() }));
vi.mock('./ai/runAdminAi', () => ({ adminAiTextOutputSchema: {}, runAdminAi: vi.fn() }));
vi.mock('./ai/budget', () => ({ readAdminAiSpend: vi.fn() }));
vi.mock('../security/incidentSignals', () => ({ getAlarms: vi.fn() }));
import { runMorningBrief, type MorningBriefDeps } from './morningBrief';

const options = {
  enabled: true,
  environment: 'dev',
  appUrl: 'https://example.test',
  now: new Date('2026-11-12T08:00:00Z'),
};
function setup() {
  const rows = new Map<string, AdminMorningBrief>();
  const deps: MorningBriefDeps = {
    gather: vi.fn(async () => ({
      facts: 'new feedback items: 3',
      needsHuman: [{ label: 'Review feedback', href: '/admin?tab=2' }],
    })),
    summarize: vi.fn(async () => null),
    deliver: vi.fn(async () => 'sent' as const),
    store: {
      findLatest: vi.fn(
        async environment =>
          [...rows.values()]
            .filter(row => row.environment === environment)
            .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null
      ),
      saveOnce: vi.fn(async row => {
        if (!rows.has(row._id)) rows.set(row._id, { ...row, delivery: 'ready' });
        return rows.get(row._id)!;
      }),
      claimDelivery: vi.fn(async id => {
        const row = rows.get(id);
        if (row?.delivery !== 'ready') return null;
        row.delivery = 'sending';
        return row;
      }),
      finishDelivery: vi.fn(async (id, outcome) => {
        rows.get(id)!.delivery = outcome;
      }),
      setSummary: vi.fn(async (id, summary) => {
        rows.get(id)!.summary = summary;
      }),
    },
  };
  return { deps, rows };
}

describe('morning brief', () => {
  it('does no work in a disabled environment', async () => {
    const { deps } = setup();
    expect(await runMorningBrief({ ...options, enabled: false }, deps)).toBe('disabled');
    expect(deps.gather).not.toHaveBeenCalled();
    expect(deps.deliver).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'failed'])('preserves plain facts when the model is %s', async state => {
    const { deps, rows } = setup();
    if (state === 'failed') vi.mocked(deps.summarize).mockRejectedValue(new Error('provider down'));
    expect(await runMorningBrief(options, deps)).toBe('sent');
    expect(deps.deliver).toHaveBeenCalledWith(expect.stringContaining('new feedback items: 3'));
    expect(deps.deliver).toHaveBeenCalledWith(expect.stringContaining('https://example.test/admin?tab=2'));
    expect(rows.get('dev:2026-11-12')?.summary).toBeNull();
  });
  it('claims delivery once for concurrent jobs and reruns, separately by day/environment', async () => {
    const { deps } = setup();
    await Promise.all([runMorningBrief(options, deps), runMorningBrief(options, deps)]);
    expect(await runMorningBrief(options, deps)).toBe('already_attempted');
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.summarize).toHaveBeenCalledTimes(1);
    await runMorningBrief({ ...options, environment: 'production' }, deps);
    await runMorningBrief({ ...options, now: new Date('2026-11-13T08:00:00Z') }, deps);
    expect(deps.deliver).toHaveBeenCalledTimes(3);
  });
  it('does not retry an ambiguous Slack failure and retains the Dashboard facts', async () => {
    const { deps, rows } = setup();
    vi.mocked(deps.deliver).mockRejectedValue(new Error('timeout'));
    expect(await runMorningBrief(options, deps)).toBe('unconfirmed');
    expect(await runMorningBrief(options, deps)).toBe('already_attempted');
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(rows.get('dev:2026-11-12')).toMatchObject({ delivery: 'unconfirmed', facts: 'new feedback items: 3' });
  });
  it('does not resend when the process died after claiming delivery', async () => {
    const { deps, rows } = setup();
    await runMorningBrief(options, deps);
    rows.get('dev:2026-11-12')!.delivery = 'sending';
    expect(await runMorningBrief(options, deps)).toBe('already_attempted');
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });
});
