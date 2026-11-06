// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockCount, mockRefs } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockRefs: { baseApiOptions: undefined as unknown },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (opts: unknown) => {
    mockRefs.baseApiOptions = opts;
    return { get: (handler: unknown) => handler };
  },
}));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { countQuestmasterArchiveFiles: (...a: unknown[]) => mockCount(...a) },
}));

const { default: handler } = await import('@pages/api/quest-master-plans/legacy-archive');

beforeEach(() => vi.clearAllMocks());

describe('GET /api/quest-master-plans/legacy-archive', () => {
  it('accepts only a session JWT', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it("returns the caller's archived file count", async () => {
    mockCount.mockResolvedValue(3);
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'user-1' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed chain hands back the raw handler
    await (handler as any)(req, res);

    expect(mockCount).toHaveBeenCalledWith('user-1');
    expect(res._getJSONData()).toEqual({ archivedCount: 3 });
  });
});
