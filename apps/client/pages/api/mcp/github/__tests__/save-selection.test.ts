import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  patchHandler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findOne: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: () => chain,
    post: () => chain,
    patch: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.patchHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({ mcpServerRepository: { findOne: h.findOne, update: h.update } }));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken: vi.fn() }));

await import('../repositories');

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status }, json, status };
};

describe('PATCH /api/mcp/github/repositories - save selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes only the selection leaf, leaving the rest of metadata to its other writers', async () => {
    h.findOne.mockResolvedValue({
      id: 'srv-1',
      enabled: true,
      metadata: { githubLogin: 'octo', webhooks: { github: { routingToken: 'tok' } } },
    });
    const { res, status } = makeRes();

    await h.patchHandler!(
      { user: { id: 'user-1' }, body: { selectedRepositories: ['acme/repo'] }, logger: { info: vi.fn() } },
      res
    );

    expect(status).toHaveBeenCalledWith(200);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith({
      id: 'srv-1',
      'metadata.selectedRepositories': [{ fullName: 'acme/repo', owner: 'acme', repo: 'repo' }],
    });
  });
});
