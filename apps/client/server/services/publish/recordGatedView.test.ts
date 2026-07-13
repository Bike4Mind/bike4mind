import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindById, mockCreateLog } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockCreateLog: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(mockFindById(...a)) }) }),
  },
  publishedArtifactViewAuditRepository: { createLog: (...a: unknown[]) => mockCreateLog(...a) },
}));

import { recordGatedView } from './recordGatedView';

beforeEach(() => {
  mockFindById.mockReset().mockResolvedValue({ email: 'Jo@Mail.ACME.com' });
  mockCreateLog.mockReset().mockResolvedValue({});
});

describe('recordGatedView', () => {
  it('records the viewer with the registrable domain (eTLD+1) of their email', async () => {
    await recordGatedView({
      publicId: 'pub-1',
      viewerId: 'user-1',
      gateKind: 'domain',
      sourceIp: '203.0.113.7',
      userAgent: 'UA',
    });
    expect(mockCreateLog).toHaveBeenCalledWith({
      publicId: 'pub-1',
      viewerId: 'user-1',
      gateKind: 'domain',
      viewerEmailDomain: 'acme.com',
      sourceIp: '203.0.113.7',
      userAgent: 'UA',
    });
  });

  it('records an undefined domain when the viewer has no resolvable email', async () => {
    mockFindById.mockResolvedValue({ email: undefined });
    await recordGatedView({ publicId: 'pub-1', viewerId: 'user-1', gateKind: 'domain' });
    expect(mockCreateLog).toHaveBeenCalledWith(
      expect.objectContaining({ viewerId: 'user-1', viewerEmailDomain: undefined })
    );
  });

  it("stores nothing for the 'unknown' sourceIp sentinel", async () => {
    await recordGatedView({ publicId: 'pub-1', viewerId: 'user-1', gateKind: 'domain', sourceIp: 'unknown' });
    expect(mockCreateLog).toHaveBeenCalledWith(expect.objectContaining({ sourceIp: undefined }));
  });

  it('never throws when the audit write fails (best-effort)', async () => {
    mockCreateLog.mockRejectedValue(new Error('db down'));
    await expect(
      recordGatedView({ publicId: 'pub-1', viewerId: 'user-1', gateKind: 'domain' })
    ).resolves.toBeUndefined();
  });
});
