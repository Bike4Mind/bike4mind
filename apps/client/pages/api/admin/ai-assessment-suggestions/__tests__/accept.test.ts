import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { handlers, baseOptions } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  baseOptions: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => 'rate-limit' }));
const uses = vi.hoisted(() => [] as Array<(req: unknown, res: unknown, next: () => void) => void>);
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      use: (fn: unknown) => {
        if (typeof fn === 'function') uses.push(fn as (typeof uses)[number]);
        return chain;
      },
      post: (fn: typeof handlers.post) => {
        handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
const db = vi.hoisted(() => ({ findAdminTargetsByIds: vi.fn(), committed: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findAdminTargetsByIds: db.findAdminTargetsByIds },
  withTransaction: async (work: () => Promise<unknown>) => {
    const result = await work();
    db.committed();
    return result;
  },
}));
const audit = vi.hoisted(() => ({ record: vi.fn(), deny: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  isSelfOrImpersonator: (user: { id: string; impersonatedBy?: string }, targetId: string) =>
    [user.id, user.impersonatedBy].some(id => id?.toLowerCase() === targetId.toLowerCase()),
  denySelfAdminAction: audit.deny,
  recordAdminActionFromRequest: audit.record,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));
const ai = vi.hoisted(() => ({ suggestion: vi.fn(), decide: vi.fn() }));
vi.mock('@server/admin/ai/audit', () => ({
  recordAiDecision: ai.decide,
  withAiSuggestionId: (details: Record<string, unknown>, aiSuggestionId: string) => ({ ...details, aiSuggestionId }),
}));
vi.mock('@server/admin/ai/assessmentSuggestion', () => ({ userAssessmentSuggestion: ai.suggestion }));
import '@pages/api/admin/ai-assessment-suggestions/accept';

const USER_ID = 'A'.repeat(24);
const ASSESSMENT_ID = 'b'.repeat(24);
const SUGGESTION_ID = 'c'.repeat(24);
const body = (surface = 'signupRiskReview') => ({ surface, userId: USER_ID, assessmentId: ASSESSMENT_ID });

const run = async (payload: unknown, user: Record<string, unknown> = { isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'POST', body: payload });
  Object.assign(req, { user: { id: 'admin-1', username: 'reviewer', ...user }, logger: { error: vi.fn() } });
  await Promise.resolve()
    .then(() => {
      for (const middleware of uses) middleware(req, res, () => undefined);
      return handlers.post(req, res);
    })
    .catch((error: unknown) => (res.statusCode = (error as { statusCode?: number }).statusCode ?? 500));
  return res;
};

beforeEach(() => {
  db.findAdminTargetsByIds.mockReset().mockResolvedValue([]);
  db.committed.mockReset();
  audit.record.mockReset();
  audit.deny.mockReset().mockRejectedValue(Object.assign(new Error('own account'), { statusCode: 403 }));
  ai.suggestion.mockReset().mockResolvedValue({ id: SUGGESTION_ID });
  ai.decide.mockReset().mockResolvedValue({ id: SUGGESTION_ID });
});

describe('POST /api/admin/ai-assessment-suggestions/accept', () => {
  it('records the accept and a strict audit entry linking the suggestion, changing nothing else', async () => {
    const res = await run(body());

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ aiSuggestionId: SUGGESTION_ID });
    expect(ai.suggestion).toHaveBeenCalledWith('signupRiskReview', USER_ID.toLowerCase(), ASSESSMENT_ID);
    expect(ai.decide).toHaveBeenCalledWith(SUGGESTION_ID, 'accepted', {
      decidedBy: { userId: 'admin-1', name: 'reviewer' },
      overrideCostly: false,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'security.ai_assessment.accepted',
        target: expect.objectContaining({ id: USER_ID.toLowerCase() }),
        details: { surface: 'signupRiskReview', assessmentId: ASSESSMENT_ID, aiSuggestionId: SUGGESTION_ID },
      })
    );
    expect(db.committed).toHaveBeenCalledOnce();
  });

  it.each([
    ['signupRiskReview', 'users:moderate', 'credits:adjust'],
    ['heldSignupGrant', 'credits:adjust', 'users:moderate'],
  ])('on %s needs %s, not %s', async (surface, needed, other) => {
    expect((await run(body(surface), { adminPermissions: [other] })).statusCode).toBe(403);
    expect(ai.suggestion).not.toHaveBeenCalled();
    expect((await run(body(surface), { adminPermissions: [needed] })).statusCode).toBe(200);
  });

  it.each([
    ['signupRiskReview', 'user.signup_risk.denied'],
    ['heldSignupGrant', 'user.credits.denied'],
  ])('refuses %s on your own account with %s before creating a suggestion', async (surface, action) => {
    const res = await run(body(surface), { isAdmin: true, id: USER_ID.toLowerCase() });

    expect(res.statusCode).toBe(403);
    expect(audit.deny).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action }));
    expect(ai.suggestion).not.toHaveBeenCalled();
  });

  it('refuses a delegate acting on an admin account before creating a suggestion', async () => {
    db.findAdminTargetsByIds.mockResolvedValue([{ id: USER_ID.toLowerCase(), isAdmin: true }]);

    const res = await run(body(), { adminPermissions: ['users:moderate'] });

    expect(res.statusCode).toBe(403);
    expect(ai.suggestion).not.toHaveBeenCalled();
  });

  it('passes through a 400 for a non-abuse or unrelated assessment', async () => {
    ai.suggestion.mockRejectedValue(Object.assign(new Error('Only an abuse assessment'), { statusCode: 400 }));

    expect((await run(body())).statusCode).toBe(400);
    expect(ai.decide).not.toHaveBeenCalled();
  });

  it('is a 409 when the suggestion was decided in between, and audits nothing', async () => {
    ai.decide.mockResolvedValue(null);

    expect((await run(body())).statusCode).toBe(409);
    expect(audit.record).not.toHaveBeenCalled();
    expect(db.committed).not.toHaveBeenCalled();
  });

  it('rolls the accept back when the strict audit write fails', async () => {
    audit.record.mockRejectedValue(new Error('audit down'));

    expect((await run(body())).statusCode).toBe(500);
    expect(db.committed).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    expect((await run({ surface: 'shadowDetection', userId: USER_ID, assessmentId: ASSESSMENT_ID })).statusCode).toBe(
      400
    );
    expect(ai.suggestion).not.toHaveBeenCalled();
  });
});
