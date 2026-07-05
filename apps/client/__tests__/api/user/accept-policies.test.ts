import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the handler (idiom from refreshToken.test.ts). baseApi() defaults to auth: true, but the
// handler reads req.user directly, so the test supplies it on the mock request.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: any) => fn,
  }),
}));

// The endpoint is thin: business logic lives in userService.recordPolicyAcceptance (covered by its
// own unit test). Here we only verify the route wiring - auth guard + pass-through.
const mockRecordPolicyAcceptance = vi.fn();
vi.mock('@bike4mind/services', () => ({
  userService: {
    recordPolicyAcceptance: (...args: any[]) => mockRecordPolicyAcceptance(...args),
  },
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: {},
}));

import handler from '../../../pages/api/user/accept-policies';

describe('POST /api/user/accept-policies — route wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordPolicyAcceptance.mockResolvedValue({ id: 'user-1', aupAcceptedVersion: 'v1', ageAttestedAdult: true });
  });

  it('delegates to userService.recordPolicyAcceptance and returns the updated user', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { ageAttestation: true } });
    (req as any).user = { id: 'user-1' };

    await (handler as any)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockRecordPolicyAcceptance).toHaveBeenCalledWith(
      { userId: 'user-1', ageAttestation: true },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData().user).toMatchObject({ aupAcceptedVersion: 'v1' });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { ageAttestation: true } });

    await (handler as any)(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockRecordPolicyAcceptance).not.toHaveBeenCalled();
  });
});
