import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: [] as { get?: Handler; post?: Handler; options: unknown }[],
  owner: vi.fn(),
  quota: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
  audit: vi.fn(),
  status: vi.fn(),
  latest: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    const handlers: { get?: Handler; post?: Handler; options: unknown } = { options };
    h.handlers.push(handlers);
    const chain = {
      use: () => chain,
      get: (fn: Handler) => {
        handlers.get = fn;
        return chain;
      },
      post: (fn: Handler) => {
        handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrf' }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.quota, releaseFromFixedWindow: h.release },
}));
vi.mock('@bike4mind/database/infra', () => ({
  OrganizationAuditEventModel: { findOne: () => ({ sort: () => ({ lean: h.latest }) }) },
}));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl: () => 'queue' }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.send }));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEvent: h.audit }));
vi.mock('@bike4mind/server-utils/utils/organizationDataExport', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/organizationDataExport')>()),
  requireOrganizationExportOwner: h.owner,
  organizationExportStatus: h.status,
}));
import '../index';
import '../[jobId]';
const id = 'a'.repeat(24);
const jobId = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
function call(method: 'post' | 'get', route = 0, userId = 'owner') {
  const { req, res } = createMocks({ method: method.toUpperCase(), query: { id, jobId } });
  Object.assign(req, { user: { id: userId } });
  return { res, promise: h.handlers[route][method]!(req, res) };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.owner.mockResolvedValue({ userId: 'owner' });
  h.quota.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 3600000) });
  h.audit.mockResolvedValue(undefined);
  h.send.mockResolvedValue(undefined);
  h.status.mockResolvedValue({ status: 'ready', url: 'https://example.test/export' });
});
describe('organization export routes', () => {
  it('requires first-party sessions on both routes', () => {
    expect(h.handlers.map(route => route.options)).toEqual([{ auth: 'jwtOnly' }, { auth: 'jwtOnly' }]);
  });
  it('audits the owner request before enqueue and returns a job id', async () => {
    const { res, promise } = call('post');
    await promise;
    expect(res._getStatusCode()).toBe(202);
    expect(h.owner).toHaveBeenCalledWith({ id: 'owner' }, id);
    expect(h.send).toHaveBeenCalledWith('queue', {
      kind: 'organization',
      id,
      userId: 'owner',
      exportJobId: res._getJSONData().exportJobId,
    });
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]);
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });
  it('rejects nonowners before audit, enqueue or signing', async () => {
    h.owner.mockRejectedValue(new Error('owner required'));
    await expect(call('post', 0, 'member').promise).rejects.toThrow('owner required');
    await expect(call('get', 1, 'outsider').promise).rejects.toThrow('owner required');
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
  });
  it('does not enqueue when audit fails, and releases the quota', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit failed'));
    await expect(call('post').promise).rejects.toThrow('audit failed');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalled();
  });
  it('audits enqueue failure and releases the quota', async () => {
    h.send.mockRejectedValue(new Error('queue failed'));
    await expect(call('post').promise).rejects.toThrow('queue failed');
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'export.failed' }));
    expect(h.release).toHaveBeenCalled();
  });
  it('rate limits before enqueue', async () => {
    h.quota.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 10000) });
    await expect(call('post').promise).rejects.toMatchObject({ statusCode: 429 });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('returns completion only after the owner gate', async () => {
    const { res, promise } = call('get', 1);
    await promise;
    expect(h.status).toHaveBeenCalledWith(id, 'owner', jobId, false);
    expect(res._getJSONData().status).toBe('ready');
    expect(res.getHeader('Cache-Control')).toContain('no-store');
  });
});
