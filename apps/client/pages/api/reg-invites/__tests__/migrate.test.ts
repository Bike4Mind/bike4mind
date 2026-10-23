import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findByEmail: vi.fn(),
  createUser: vi.fn(),
  publish: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({ withTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findByEmail: h.findByEmail } }));
vi.mock('@bike4mind/services', () => ({
  userService: { createUser: h.createUser },
  organizationService: { addMember: vi.fn() },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));

process.env.APP_URL = 'https://app.test';
await import('../migrate');

const run = (usersData: unknown[], sendEmail = false) =>
  h.handler!(
    { body: { usersData, sendEmail }, user: { id: 'admin-1', isAdmin: true }, ability: {}, logger: {} },
    { json: vi.fn() }
  );

describe('POST /api/reg-invites/migrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByEmail.mockResolvedValue(null);
    h.createUser.mockImplementation(async (params: { email: string; name: string }) => ({
      id: 'new-1',
      ...params,
    }));
  });

  it('derives a rules-conformant username from the display name', async () => {
    await run([{ email: 'a@b.test', name: 'Jane <b>Doe</b>' }]);

    expect(h.createUser.mock.calls[0][0].username).toBe('Jane bDoeb');
  });

  it('falls back to a generated username when nothing usable remains', async () => {
    await run([{ email: 'a@b.test', name: '---' }]);

    expect(h.createUser.mock.calls[0][0].username).toMatch(/^user-[0-9a-f]{8}$/);
  });

  it('never derives the reserved test-persona prefix from a display name', async () => {
    await run([{ email: 'a@b.test', name: 'Persona-Jane Doe' }]);

    expect(h.createUser.mock.calls[0][0].username).toBe('Jane Doe');
  });

  it('escapes the name in the welcome email body', async () => {
    await run([{ email: 'a@b.test', name: `<i>x</i> 'q'` }], true);

    const { body } = h.publish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Hello &lt;i&gt;x&lt;/i&gt; &#39;q&#39;,');
  });

  it('records one best-effort .migrated entry with the counts after the loop', async () => {
    h.createUser.mockRejectedValueOnce(new Error('boom'));
    await run([
      { email: 'a@b.test', name: 'A' },
      { email: 'c@d.test', name: 'C' },
    ]);

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.accounts.migrated',
        target: { kind: 'system', id: 'reg_invite_migration', displayName: 'user migration' },
        details: expect.objectContaining({ requested: 2, migrated: 1, failed: 1 }),
      })
    );
    const lastCreate = h.createUser.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastCreate).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not audit a run that migrated nobody', async () => {
    h.createUser.mockRejectedValue(new Error('boom'));
    await expect(run([{ email: 'a@b.test', name: 'A' }])).rejects.toThrow(/no users were migrated/i);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
