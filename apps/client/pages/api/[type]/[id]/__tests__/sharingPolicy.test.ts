import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
const mocks = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<void>),
  content: vi.fn(),
  org: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return handler;
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { shareable: { findShareAccessById: mocks.content } },
  projectRepository: { shareable: { findShareAccessById: mocks.content } },
  fabFileRepository: { shareable: { findShareAccessById: mocks.content } },
  organizationRepository: { findById: mocks.org },
}));
import '../sharingPolicy';
beforeEach(() => vi.clearAllMocks());
describe('content sharing policy API', () => {
  it('returns policy only after content share authorization', async () => {
    mocks.content.mockResolvedValue({ organizationId: 'org' });
    mocks.org.mockResolvedValue({
      sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: [] },
    });
    const { req, res } = createMocks({ query: { type: 'sessions', id: 'session' } });
    await mocks.handler!(req, res);
    expect(res._getJSONData().policy.allowPublicLinks).toBe(false);
  });
  it('does not disclose policy when the content is inaccessible', async () => {
    mocks.content.mockResolvedValue(null);
    const { req, res } = createMocks({ query: { type: 'sessions', id: 'foreign' } });
    await expect(mocks.handler!(req, res)).rejects.toThrow('Content not found');
    expect(mocks.org).not.toHaveBeenCalled();
  });
});
