import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), upload: vi.fn(), download: vi.fn(), findOne: vi.fn() }));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ outboundActionGate: () => () => undefined }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (...handlers: unknown[]) => handlers.at(-1) }),
}));
vi.mock('@server/services/publish/organizationPolicy', () => ({ assertPublicationPublicLink: mocks.policy }));
vi.mock('@bike4mind/database', () => ({ PublishedArtifact: { findOne: mocks.findOne } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ upload: mocks.upload, download: mocks.download }),
}));
vi.mock('@server/services/publish', () => ({
  checkScopePermission: async () => ({ ok: true }),
  resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
}));
import uploadUrl from '../upload-url';
import finalize from '../finalize';

const draftId = '33333333-3333-4333-8333-333333333333';
const draft = {
  draftId,
  createdAt: new Date().toISOString(),
  createdBy: 'owner',
  tier: 'user',
  scopeId: 'owner',
  slug: 'artifact',
  title: 'Artifact',
  visibility: 'public',
  source: { kind: 'bundle', artifactId: 'bound-artifact' },
  files: [{ path: 'index.html', size: 10, mimeType: 'text/html' }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.mockRejectedValue(new ForbiddenError('Your organization does not allow public links for this content.'));
  mocks.download.mockResolvedValue(Buffer.from(JSON.stringify(draft)));
});
describe('publication API organization restrictions', () => {
  it.each([
    ['upload-url', uploadUrl, draft],
    ['finalize', finalize, { draftId }],
  ])('refuses %s before publication writes, even in personal target scope', async (_name, handler, body) => {
    const { req, res } = createMocks({ method: 'POST', body });
    Object.assign(req, { user: { id: 'owner' } });
    await expect((handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)).rejects.toMatchObject(
      { statusCode: 403 }
    );
    expect(mocks.policy).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'bundle', artifactId: 'bound-artifact' } })
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});
