// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const m = vi.hoisted(() => ({
  summarize: vi.fn(),
  getSettingsMap: vi.fn(),
  baseApiOptions: undefined as unknown,
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  imageModerationIncidentRepository: { summarize: m.summarize },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: m.getSettingsMap,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    m.baseApiOptions = options;
    return {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => ({
        get: (h: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
          guard(req, res, () => {});
          return h(req, res);
        },
      }),
    };
  },
}));

import handler from '../summary';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const makeReq = (user: unknown = { id: 'admin-1', isAdmin: true }) => ({ method: 'GET', user, query: {} });
const jsonOf = (res: Record<string, unknown>) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

const OLDEST = new Date('2026-10-30T10:00:00Z');
const SUMMARY = {
  needsReview: 4,
  escalated: 2,
  stuck: 1,
  closed: { noAction: 5, falsePositive: 3, reported: 2 },
  oldestPendingCreatedAt: OLDEST,
};

describe('admin/moderation-incidents/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.summarize.mockResolvedValue(SUMMARY);
    m.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: '["reviewer@example.com"]',
      ImageModerationEscalationEmails: '["second@example.com"]',
    });
  });

  it('takes the moderation page permissions on a signed-in session only', () => {
    expect(m.baseApiOptions).toEqual({ auth: 'jwtOnly', requiredScopes: ['admin:*'], allowedMethods: ['GET'] });
  });

  it('returns the counts and whether each reviewer list is configured', async () => {
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonOf(res)).toEqual({
      ...SUMMARY,
      reviewersConfigured: true,
      escalationReviewersConfigured: true,
    });
  });

  it.each([
    ['empty', '[]', false],
    ['absent', undefined, false],
    ['invalid only', '["not-an-address"]', false],
    ['valid', '["reviewer@example.com", "not-an-address"]', true],
  ])('says whether a %s list is configured', async (_label, stored, expected) => {
    m.getSettingsMap.mockResolvedValue({
      ImageModerationReviewerEmails: stored,
      ImageModerationEscalationEmails: stored,
    });
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(jsonOf(res)).toMatchObject({ reviewersConfigured: expected, escalationReviewersConfigured: expected });
  });

  it('judges the two lists separately', async () => {
    m.getSettingsMap.mockResolvedValue({ ImageModerationReviewerEmails: '["reviewer@example.com"]' });
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(jsonOf(res)).toMatchObject({ reviewersConfigured: true, escalationReviewersConfigured: false });
  });

  it('carries no address, id or label, even when the repository hands back more', async () => {
    m.summarize.mockResolvedValue({
      ...SUMMARY,
      ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      userId: 'user-1',
      labels: [{ name: 'Example label', parentName: '', confidence: 90 }],
    });
    const res = makeRes();
    await runHandler(makeReq(), res);

    const payload = jsonOf(res);
    expect(Object.keys(payload).sort()).toEqual([
      'closed',
      'escalated',
      'escalationReviewersConfigured',
      'needsReview',
      'oldestPendingCreatedAt',
      'reviewersConfigured',
      'stuck',
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('aaaaaaaa');
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('Example label');
  });

  it.each(['support:read', 'users:moderate'])('admits a %s delegate', async permission => {
    const res = makeRes();
    await runHandler(makeReq({ id: 'delegate', adminPermissions: [permission] }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([undefined, { id: 'u', isAdmin: false }, { id: 'u', adminPermissions: ['credits:adjust'] }])(
    'refuses an unauthorized caller %j before reading',
    async user => {
      await expect(runHandler({ method: 'GET', user, query: {} }, makeRes())).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(m.summarize).not.toHaveBeenCalled();
      expect(m.getSettingsMap).not.toHaveBeenCalled();
    }
  );
});
