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
const mockStored = vi.fn();
const mockAudit = vi.fn();
vi.mock('@bike4mind/database', () => ({ withTransaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: (...a: unknown[]) => mockAudit(...a) }));
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: () => ({ lean: () => mockStored() }),
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
    mockStored.mockResolvedValue(null);
    mockAudit.mockResolvedValue(null);
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

describe('PUT /api/admin/llm-models/configurations - admin audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({});
    mockStored.mockResolvedValue(null);
    mockAudit.mockResolvedValue(null);
  });

  it('records a strict llmModelConfigurations entry with the stored and saved lists', async () => {
    const previous = [{ id: 'model-a', enabled: false, allowedUserTags: [] }];
    mockStored.mockResolvedValue({ settingValue: previous });

    await put({});

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'llmModelConfigurations' },
      changes: [
        {
          field: 'llmModelConfigurations',
          before: previous,
          after: [{ id: 'model-a', enabled: true, allowedUserTags: [] }],
        },
      ],
    });
    expect(mockFindOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockAudit.mock.invocationCallOrder[0]);
  });

  it('records before as null when nothing was stored', async () => {
    await put({});
    expect(mockAudit.mock.calls[0][1].changes[0].before).toBeNull();
  });

  it('does not report success when the audit write rejects', async () => {
    mockAudit.mockRejectedValue(new Error('audit down'));
    const res = { json: vi.fn() };
    const req = {
      user: { isAdmin: true },
      ability: {},
      body: { configurations: [{ id: 'model-a', enabled: true, allowedUserTags: [] }] },
    };

    await expect(captured.put!(req, res)).rejects.toThrow(/audit down/);
    expect(res.json).not.toHaveBeenCalled();
  });
});
