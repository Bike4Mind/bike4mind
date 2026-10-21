import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const captured = vi.hoisted(() => ({ put: undefined as Handler | undefined }));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: () => chain,
    put: (fn: Handler) => {
      captured.put = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
const mockFindOneAndUpdate = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: vi.fn(),
    syncIndexes: vi.fn(),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
}));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: vi.fn() }));

import '../configurations';

function put(config: Record<string, unknown>) {
  const req = {
    user: { isAdmin: true },
    ability: {},
    body: { configurations: [{ id: 'model-a', enabled: true, allowedUserTags: [], ...config }] },
  };
  const res = { json: vi.fn() };
  return captured.put!(req, res);
}

describe('PUT /api/admin/llm-models/configurations - source: namespace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({});
  });

  it('refuses a self-assignable source: tag in allowedUserTags', async () => {
    await expect(put({ allowedUserTags: ['vip', 'Source:Acme'] })).rejects.toThrow(/allowedUserTags\[1\]/);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses a source: key in allowedEntitlements', async () => {
    await expect(put({ allowedEntitlements: ['source:acme'] })).rejects.toThrow(/allowedEntitlements\[0\]/);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('saves ordinary tags and entitlements', async () => {
    await put({ allowedUserTags: ['vip'], allowedEntitlements: ['acme:pro'] });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
