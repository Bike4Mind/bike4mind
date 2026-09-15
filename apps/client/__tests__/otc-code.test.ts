import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the security gating of the test-only OTC-code endpoint.
const mockIsE2EEnabled = vi.fn();
const mockGetDebugCode = vi.fn();

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (h: unknown) => h }) }));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: () => mockIsE2EEnabled() }));
vi.mock('@bike4mind/database', () => ({
  pendingOtcTokenRepository: { getDebugCode: (...a: unknown[]) => mockGetDebugCode(...a) },
}));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: { value: 'secret-123' } } }));

const SECRET = 'secret-123';
const TEST_EMAIL = 'setup-admin-123-e2e@test.com';

describe('/api/test/otc-code — gating', () => {
  let handler: (...a: unknown[]) => unknown;
  const makeRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
  const makeReq = (headers: Record<string, unknown>, query: Record<string, unknown>) => ({ headers, query });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsE2EEnabled.mockReturnValue(true);
    handler = (await import('@pages/api/test/otc-code')).default;
  });

  it('404s when E2E endpoints are disabled (production) and never reads the code', async () => {
    mockIsE2EEnabled.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ 'x-e2e-cleanup-secret': SECRET }, { email: TEST_EMAIL }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetDebugCode).not.toHaveBeenCalled();
  });

  it('401s on a wrong/missing secret', async () => {
    const res = makeRes();
    await handler(makeReq({ 'x-e2e-cleanup-secret': 'wrong' }, { email: TEST_EMAIL }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockGetDebugCode).not.toHaveBeenCalled();
  });

  it("400s for a non-test email (cannot reveal a real user's code)", async () => {
    const res = makeRes();
    await handler(makeReq({ 'x-e2e-cleanup-secret': SECRET }, { email: 'real@company.com' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetDebugCode).not.toHaveBeenCalled();
  });

  it('returns the code for a valid test account', async () => {
    mockGetDebugCode.mockResolvedValue('123456');
    const res = makeRes();
    await handler(makeReq({ 'x-e2e-cleanup-secret': SECRET }, { email: TEST_EMAIL }), res);
    expect(mockGetDebugCode).toHaveBeenCalledWith(TEST_EMAIL);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ code: '123456' });
  });

  it('404s when no code is on record', async () => {
    mockGetDebugCode.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq({ 'x-e2e-cleanup-secret': SECRET }, { email: TEST_EMAIL }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
