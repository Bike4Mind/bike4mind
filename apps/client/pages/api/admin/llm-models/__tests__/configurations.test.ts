import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  get: undefined as Handler | undefined,
  put: undefined as Handler | undefined,
  find: vi.fn(),
  revision: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (handler: Handler) => handler }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (handler: Handler) => {
      h.get = handler;
      return chain;
    },
    put: (handler: Handler) => {
      h.put = handler;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database/infra', () => ({ AdminSettings: { findOne: (...args: unknown[]) => h.find(...args) } }));
vi.mock('@bike4mind/server-utils/modelDiscovery/modelAccessRevision', () => ({
  readModelAccessRevision: () => h.revision(),
}));
vi.mock('@server/modelAccess/modelAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/modelAccess/modelAccess')>()),
  saveModelAccess: (...args: unknown[]) => h.save(...args),
}));
import '../configurations';

const respond = () => ({ json: vi.fn(), setHeader: vi.fn() });
const stamp = '2026-11-01T00:00:00.000Z';
const entry = { id: 'model-a', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'] };
const body = {
  changes: [{ id: 'model-a', change: { enabled: false }, expectedUpdatedAt: stamp }],
  reason: 'Update model availability',
};
beforeEach(() => {
  vi.clearAllMocks();
  h.find.mockResolvedValue({ settingValue: [{ ...entry, updatedAt: new Date(stamp) }] });
  h.revision.mockResolvedValue('rev-1');
  h.save.mockResolvedValue({ entries: [], changed: 0, revision: null });
});

describe('conditional dashboard compatibility Save', () => {
  it('refuses an unversioned old-client body with reload-required 409 and no writes', async () => {
    await expect(
      h.put!({ user: { isAdmin: true }, body: { configurations: [entry] } }, respond())
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Reload') });
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each([
    { user: { isAdmin: false, adminPermissions: ['settings:manage'] } },
    { user: { isAdmin: true }, apiKeyInfo: { scopes: ['admin:*'] } },
    { user: undefined },
  ])('refuses delegates, API keys and unauthenticated callers before writing: %j', async credentials => {
    await expect(h.put!({ ...credentials, body }, respond())).rejects.toMatchObject({ statusCode: 403 });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('accepts the validated changed-entry request from a full-admin session', async () => {
    const request = { user: { isAdmin: true }, body };
    const response = respond();
    await h.put!(request, response);
    expect(h.save).toHaveBeenCalledWith(request, body);
    expect(response.json).toHaveBeenCalledWith({ entries: [], changed: 0, revision: null });
  });

  it.each([
    { ...body, reason: '' },
    { ...body, changes: [...body.changes, ...body.changes] },
    { ...body, changes: [{ ...body.changes[0], change: { allowedUserTags: ['source:oauth'] } }] },
    { ...body, changes: [{ ...body.changes[0], change: { rank: 101 } }] },
  ])('validates reason, unique IDs, namespaces and rank: %j', async invalid => {
    await expect(h.put!({ user: { isAdmin: true }, body: invalid }, respond())).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('configuration reads', () => {
  it('keeps the picker body shape and returns the pre-read revision header', async () => {
    const response = respond();
    await h.get!({ user: { id: 'u1' } }, response);
    expect(response.setHeader).toHaveBeenCalledWith('x-model-access-revision', 'rev-1');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.json).toHaveBeenCalledWith({ settingValue: [entry] });
    expect(h.revision.mock.invocationCallOrder[0]).toBeLessThan(h.find.mock.invocationCallOrder[0]);
  });

  it('adds the actually loaded entry stamps for a full-admin editor', async () => {
    const response = respond();
    await h.get!({ user: { isAdmin: true } }, response);
    expect(response.json).toHaveBeenCalledWith({ settingValue: [{ ...entry, updatedAt: stamp }] });
  });

  it('preserves legacy missing-enabled semantics and allows a truly absent setting', async () => {
    h.find.mockResolvedValueOnce({ settingValue: [{ id: 'legacy', allowedUserTags: [] }] }).mockResolvedValueOnce(null);
    const legacy = respond();
    await h.get!({ user: { id: 'u1' } }, legacy);
    expect(legacy.json).toHaveBeenCalledWith({ settingValue: [{ id: 'legacy', enabled: false, allowedUserTags: [] }] });
    const missing = respond();
    await h.get!({ user: { id: 'u1' } }, missing);
    expect(missing.json).toHaveBeenCalledWith({ settingValue: [] });
  });

  it('does not turn a failed or corrupt access read into an empty default-restoring list', async () => {
    h.find.mockRejectedValueOnce(new Error('Access read failed')).mockResolvedValueOnce({ settingValue: 'invalid' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = respond();
      await expect(h.get!({ user: { id: 'u1' } }, response)).rejects.toThrow();
      expect(response.json).not.toHaveBeenCalled();
    }
  });

  it('keeps serving real configurations when the advisory revision read is unavailable', async () => {
    h.revision.mockRejectedValue(new Error('Revision read failed'));
    const response = respond();
    await h.get!({ user: { id: 'u1' } }, response);
    expect(response.setHeader).not.toHaveBeenCalledWith('x-model-access-revision', expect.anything());
    expect(response.json).toHaveBeenCalledWith({ settingValue: [entry] });
  });
});
