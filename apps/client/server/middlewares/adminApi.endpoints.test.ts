import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { ApiKeyStatus, type AdminPermissionId } from '@bike4mind/common';

vi.mock('./baseApi', () => ({
  baseApi: () => {
    const guards: ((req: Request, res: Response, next: () => void) => unknown)[] = [];
    const endpoints: Record<string, (req: Request, res: Response) => unknown> = {};
    const chain = async (req: Request, res: Response) => {
      try {
        for (const guard of guards) await guard(req, res, () => {});
        return await endpoints[req.method](req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return res.status(message.startsWith('Missing permission:') ? 403 : 400).json({ error: message });
      }
    };
    chain.use = (guard: (typeof guards)[number]) => {
      guards.push(guard);
      return chain;
    };
    for (const method of ['get', 'post', 'put', 'delete']) {
      (chain as unknown as Record<string, unknown>)[method] = (handler: (typeof endpoints)[string]) => {
        endpoints[method.toUpperCase()] = handler;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (operation: () => Promise<unknown>) => operation(),
  userRepository: { findById: vi.fn() },
  organizationRepository: { findById: vi.fn() },
  creditLotRepository: {},
  creditTransactionRepository: {},
  PublishedArtifact: { findOneAndUpdate: vi.fn() },
  PublishedArtifactReport: {},
  userApiKeyRepository: { findById: vi.fn(), revokeIfNotDisabled: vi.fn() },
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ AdminSettings: {} }));
vi.mock('@bike4mind/services', () => ({ creditService: {}, authSessionService: { endRealtimeConnections: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: vi.fn(),
  recordAdminActionFromRequest: vi.fn(),
}));
vi.mock('@server/utils/adminSettingsAudit', () => ({ recordAdminSettingChange: vi.fn() }));
vi.mock('@server/utils/adminAuditQuery', () => ({ encodeAuditCursor: vi.fn(), parseUserActivityQuery: vi.fn() }));
vi.mock('@server/utils/userActivity', () => ({ hasAdminHistory: vi.fn(), listUserActivity: vi.fn() }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/services/publish', () => ({ invalidatePublishCdn: vi.fn(), toCacheTarget: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  deletePublishThumbnail: vi.fn(),
  enqueuePublishThumbnail: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/releaseNotes/adminReleaseNotes', () => ({
  loadReleaseNotesConfig: vi.fn(),
  RELEASE_NOTES_SETTING: 'releaseNotes',
}));

import supportHandler from '../../pages/api/admin/users/[userId]/activity';
import creditHandler from '../../pages/api/admin/organizations/[id]/top-up';
import moderationHandler from '../../pages/api/admin/published-artifacts/[id]/takedown';
import keyHandler from '../../pages/api/admin/user-api-keys/[id]/revoke';
import settingsHandler from '../../pages/api/admin/release-notes/config';

type Handler = (req: Request, res: Response) => Promise<void>;
const samples: { permission: AdminPermissionId; method: 'GET' | 'POST' | 'PUT'; handler: unknown; body?: unknown }[] = [
  { permission: 'support:read', method: 'GET', handler: supportHandler },
  { permission: 'credits:adjust', method: 'POST', handler: creditHandler },
  { permission: 'users:moderate', method: 'POST', handler: moderationHandler, body: { reason: 123 } },
  { permission: 'keys:revoke', method: 'POST', handler: keyHandler },
  { permission: 'settings:manage', method: 'PUT', handler: settingsHandler, body: { unrecognized: true } },
];

const call = async (sample: (typeof samples)[number], permissions: AdminPermissionId[]) => {
  const { req, res } = createMocks<Request, Response>({ method: sample.method, query: {}, body: sample.body ?? {} });
  req.user = { id: 'actor', isAdmin: false, adminPermissions: permissions } as Request['user'];
  await (sample.handler as Handler)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as { error?: string } };
};

describe('admin endpoint permission enforcement', () => {
  it.each(samples)('$permission is enforced by its real endpoint before request data is inspected', async sample => {
    const denied = await call(sample, []);
    expect(denied).toEqual({ status: 403, body: { error: `Missing permission: ${sample.permission}` } });

    // Malformed inputs prove that a delegated caller reached the actual endpoint's validation.
    const allowed = await call(sample, [sample.permission]);
    expect(allowed.status).toBe(400);
    expect(allowed.body.error).not.toContain('Missing permission:');
  });

  it.each(samples.filter(sample => sample.method !== 'GET'))(
    'support cannot invoke the $permission write endpoint',
    async sample => {
      expect(await call(sample, ['support:read'])).toEqual({
        status: 403,
        body: { error: `Missing permission: ${sample.permission}` },
      });
    }
  );
});

describe('admin key revocation connection cleanup', () => {
  it('uses the canonical stored key id for an uppercase request id', async () => {
    const { userApiKeyRepository } = await import('@bike4mind/database');
    const { authSessionService } = await import('@bike4mind/services');
    const canonicalId = '65b7f0c2a1b2c3d4e5f60718';
    vi.mocked(userApiKeyRepository.findById).mockResolvedValueOnce({
      id: canonicalId,
      status: ApiKeyStatus.ACTIVE,
      name: 'Key',
      userId: 'owner',
    } as Awaited<ReturnType<typeof userApiKeyRepository.findById>>);
    const { req, res } = createMocks<Request, Response>({
      method: 'POST',
      query: { id: canonicalId.toUpperCase() },
      body: { reason: 'Revoke compromised credential' },
    });
    req.user = { id: 'actor', isAdmin: false, adminPermissions: ['keys:revoke'] } as Request['user'];
    await (keyHandler as unknown as Handler)(req, res);
    expect(authSessionService.endRealtimeConnections).toHaveBeenCalledWith(
      { apiKeyId: canonicalId },
      expect.anything()
    );
    expect(res._getStatusCode()).toBe(200);
  });
});
