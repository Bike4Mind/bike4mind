import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminOrgRef = vi.fn();
vi.mock('../resolveAdminOrgRef', () => ({
  resolveAdminOrgRef: (...args: unknown[]) => resolveAdminOrgRef(...args),
}));
const resolveUserNames = vi.fn();
vi.mock('../../utils/resolveUserNames', () => ({
  resolveUserNames: (...args: unknown[]) => resolveUserNames(...args),
}));
const ownerUsageSummary = vi.fn();
vi.mock('@bike4mind/database', () => ({
  usageEventRepository: { ownerUsageSummary: (...args: unknown[]) => ownerUsageSummary(...args) },
}));

import { getOrgUsageTool } from './getOrgUsage';

const ORG_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runTool = async (args: unknown) =>
  JSON.parse(await getOrgUsageTool.implementation(context, undefined).toolFn(args));

const spend = (credits: number) => ({ requests: 1, cogsUsd: credits / 1000, creditsCharged: credits });

const summary = (overrides: Record<string, unknown> = {}) => ({
  overTime: [{ day: '2026-10-01', ...spend(30) }],
  byMember: [
    { userId: 'u1', ...spend(20) },
    { userId: 'u2', ...spend(10) },
  ],
  byModel: [{ provider: 'anthropic', model: 'claude', ...spend(30) }],
  byFeature: [{ feature: 'chat', ...spend(30) }],
  totals: spend(30),
  ...overrides,
});

describe('getOrgUsageTool', () => {
  beforeEach(() => {
    resolveAdminOrgRef.mockReset().mockResolvedValue({
      ok: true,
      org: { id: ORG_ID, name: 'Acme', currentCredits: 900 },
    });
    resolveUserNames.mockReset().mockResolvedValue(new Map([['u1', 'Ada']]));
    ownerUsageSummary.mockReset().mockResolvedValue(summary());
  });

  it('passes a resolver failure straight through', async () => {
    resolveAdminOrgRef.mockResolvedValue({ ok: false, error: 'not_found', message: 'nope' });

    expect(await runTool({ name: 'Nope' })).toEqual({ ok: false, error: 'not_found', message: 'nope' });
    expect(ownerUsageSummary).not.toHaveBeenCalled();
  });

  it('reads the org-owned rollup for the default 30 days and names the members', async () => {
    const result = await runTool({ orgId: ORG_ID });

    expect(ownerUsageSummary).toHaveBeenCalledWith(ORG_ID, 'Organization', 30);
    expect(result.data).toEqual({
      organization: { id: ORG_ID, name: 'Acme', currentCredits: 900 },
      days: 30,
      totals: spend(30),
      overTime: [{ day: '2026-10-01', ...spend(30) }],
      byMember: [
        { userId: 'u1', name: 'Ada', ...spend(20) },
        { userId: 'u2', name: null, ...spend(10) },
      ],
      byModel: [{ provider: 'anthropic', model: 'claude', ...spend(30) }],
      byFeature: [{ feature: 'chat', ...spend(30) }],
      truncated: { byMember: false, byModel: false, byFeature: false },
    });
  });

  it('keeps the top 10 rows of each breakdown and flags the cut', async () => {
    ownerUsageSummary.mockResolvedValue(
      summary({ byMember: Array.from({ length: 12 }, (_, index) => ({ userId: `u${index}`, ...spend(12 - index) })) })
    );

    const result = await runTool({ orgId: ORG_ID, days: 7 });

    expect(ownerUsageSummary).toHaveBeenCalledWith(ORG_ID, 'Organization', 7);
    expect(result.data.byMember).toHaveLength(10);
    expect(result.data.byMember[0].userId).toBe('u0');
    expect(result.data.truncated.byMember).toBe(true);
    expect(resolveUserNames.mock.calls[0][0]).toHaveLength(10);
  });

  it('rejects a window beyond 90 days', async () => {
    expect(await runTool({ orgId: ORG_ID, days: 365 })).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
