import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { UnauthorizedError } from '@bike4mind/common';

/**
 * GET /api/artifacts/[id]/versions/[version] returns raw version content. It must funnel through
 * the canonical artifact read predicate (artifactService.get) first, exactly like the list-versions
 * sibling - otherwise any authenticated user can read another user's private version content by id.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  get: vi.fn(),
  findByVersion: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/services', () => ({
  artifactService: {
    get: (...args: unknown[]) => mockRefs.get(...args),
  },
}));

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { __repo: 'artifacts' },
  artifactContentRepository: { findById: (...args: unknown[]) => mockRefs.findById(...args) },
  artifactVersionRepository: { findByVersion: (...args: unknown[]) => mockRefs.findByVersion(...args) },
}));

// Import after mocks so the chain captures the handler.
import '../[id]/versions/[version]';

function invoke(userId: string, artifactId: string, version: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id: artifactId, version } });
  (req as any).user = { id: userId };
  return { req, res };
}

describe('GET /api/artifacts/[id]/versions/[version]', () => {
  beforeEach(() => {
    mockRefs.get.mockReset();
    mockRefs.findByVersion.mockReset();
    mockRefs.findById.mockReset();
  });

  it('denies a caller who cannot read the parent artifact, without touching content', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    mockRefs.get.mockRejectedValueOnce(new UnauthorizedError('Access denied'));

    const { req, res } = invoke('attacker', 'victim-artifact', '1');

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(UnauthorizedError);
    expect(mockRefs.findByVersion).not.toHaveBeenCalled();
    expect(mockRefs.findById).not.toHaveBeenCalled();
  });

  it('returns version content once the read predicate passes', async () => {
    mockRefs.get.mockResolvedValueOnce({ artifact: { id: 'artifact-1' } });
    mockRefs.findByVersion.mockResolvedValueOnce({
      contentId: { toString: () => 'content-1' },
      versionTag: 'v1',
      createdAt: new Date('2024-01-01'),
    });
    mockRefs.findById.mockResolvedValueOnce({ content: 'secret body' });

    const { req, res } = invoke('owner', 'artifact-1', '1');

    await mockRefs.getHandler!(req, res);

    expect(mockRefs.get).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ id: 'artifact-1', includeContent: false }),
      expect.anything()
    );
    expect(res._getJSONData()).toEqual(
      expect.objectContaining({ success: true, data: expect.objectContaining({ content: 'secret body' }) })
    );
  });
});
