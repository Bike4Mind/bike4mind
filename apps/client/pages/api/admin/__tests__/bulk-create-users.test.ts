import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  update: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({ userRepository: { update: h.update } }));
vi.mock('@bike4mind/services', () => ({ userService: { createUser: h.createUser } }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('@server/utils/mailer/emailHelpers', () => ({
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));

await import('../bulk-create-users');

const makeReq = (users: unknown[]) => ({
  body: { users },
  user: { id: 'admin-1', isAdmin: true },
  ability: {},
});

describe('POST /api/admin/bulk-create-users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createUser.mockResolvedValue({ id: 'new-1', email: 'a@b.test', name: 'a@b.test', storageLimit: 1000 });
  });

  it('writes exactly the storage limit and tags when both are given', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test', startingStorage: 5000, tags: ['x', 'y'] }]), res);

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'new-1', storageLimit: 5000, tags: ['x', 'y'] });
  });

  it('writes the created defaults, with tags undefined, when neither is given', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test' }]), res);

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'new-1', storageLimit: 1000, tags: undefined });
  });

  it('reports an invalid row as a per-row failure without failing the batch', async () => {
    const json = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json };

    await h.handler!(makeReq([{ email: 'a@b.test' }, { first: 'no-email' }]), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const { results } = json.mock.calls[0][0];
    expect(results[0]).toMatchObject({ success: true, email: 'a@b.test' });
    expect(results[1]).toMatchObject({ success: false, error: expect.any(String) });
  });
});
