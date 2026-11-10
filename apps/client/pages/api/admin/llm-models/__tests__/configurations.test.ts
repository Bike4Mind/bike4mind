import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const captured = vi.hoisted(() => ({ get: undefined as Handler | undefined, put: undefined as Handler | undefined }));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: Handler) => {
      captured.get = fn;
      return chain;
    },
    put: (fn: Handler) => {
      captured.put = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockReadRevision = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: (...a: unknown[]) => mockFindOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
}));
vi.mock('@bike4mind/server-utils/modelDiscovery/modelAccessRevision', () => ({
  readModelAccessRevision: () => mockReadRevision(),
}));

import '../configurations';

const respond = () => ({ json: vi.fn(), setHeader: vi.fn() });

describe('PUT /api/admin/llm-models/configurations', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['a full admin', { isAdmin: true }],
    ['a settings:manage delegate', { isAdmin: false, adminPermissions: ['settings:manage'] }],
  ])('returns 410 to %s and writes nothing', async (_label, user) => {
    const res = respond();
    const req = { user, body: { configurations: [{ id: 'model-a', enabled: true, allowedUserTags: [] }] } };

    await expect(captured.put!(req, res)).rejects.toMatchObject({
      statusCode: 410,
      message: 'Use the per-model access editor',
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/llm-models/configurations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue({
      settingValue: [
        { id: 'model-a', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'], updatedAt: new Date() },
      ],
    });
  });

  it('sends the access revision in a header and keeps the body shape', async () => {
    mockReadRevision.mockResolvedValue('rev-1');
    const res = respond();

    await captured.get!({ user: { id: 'u1' } }, res);

    expect(res.setHeader).toHaveBeenCalledWith('x-model-access-revision', 'rev-1');
    expect(res.json).toHaveBeenCalledWith({
      settingValue: [{ id: 'model-a', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'] }],
    });
  });

  it('sends no header before the first bump or when the revision read fails', async () => {
    mockReadRevision.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db down'));

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = respond();
      await captured.get!({ user: { id: 'u1' } }, res);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledOnce();
    }
  });
});
