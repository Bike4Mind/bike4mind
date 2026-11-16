import { describe, it, expect, vi } from 'vitest';
import { mockRoute, tavernUser, type RouteHandler } from './testUtils';

const refs = vi.hoisted(() => ({
  post: null as null | RouteHandler,
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: RouteHandler) => {
      refs.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => () => undefined }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));
vi.mock('@bike4mind/database', () => ({ ccBridgePairingTokenRepository: { create: refs.create } }));
vi.mock('@bike4mind/fab-pipeline', () => ({ S3Storage: vi.fn() }));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));

import '../download';

describe('POST /api/cc-bridge/download - org service account', () => {
  it('refuses a service-account caller and mints nothing', async () => {
    const { req, res } = mockRoute({
      user: { ...tavernUser, isSystem: true, serviceAccountOrganizationId: 'org-1' },
      body: { os: 'linux', arch: 'x64' },
    });
    await expect(refs.post!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(refs.create).not.toHaveBeenCalled();
  });
});
