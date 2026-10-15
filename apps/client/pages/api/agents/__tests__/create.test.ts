import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  incrementCredits: vi.fn(),
  countByUserId: vi.fn(),
  agentCreate: vi.fn(),
  subtractCredits: vi.fn(),
  addCredits: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: () => ({
      post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        h.handler = fn;
        return {};
      },
    }),
  }),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, incrementCredits: h.incrementCredits },
  agentRepository: { countByUserId: h.countByUserId, create: h.agentCreate },
  creditTransactionRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@bike4mind/services', () => ({
  creditService: { subtractCredits: h.subtractCredits, addCredits: h.addCredits },
}));

vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls: vi.fn() }));

await import('../index');

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status }, json, status };
};

describe('POST /api/agents - credit allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue({ id: 'user-1', level: 'PaidUser', currentCredits: 100 });
    h.countByUserId.mockResolvedValue(0);
    h.agentCreate.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'agent-1', ...data }));
  });

  const post = (body: Record<string, unknown>) => {
    const r = makeRes();
    return { ...r, run: () => h.handler!({ user: { id: 'user-1' }, body }, r.res) };
  };

  it('funds the agent through a ledgered transfer and reports the persisted user balance', async () => {
    // A concurrent spend moved the stored balance since the read: 100 - 30 in memory, but 50 in the DB.
    h.subtractCredits.mockResolvedValue({ id: 'user-1', currentCredits: 50 });
    h.addCredits.mockResolvedValue({ id: 'agent-1', currentCredits: 30 });
    const { run, json, status } = post({ name: 'Agent', useOwnCredits: true, currentCredits: 30 });

    await run();

    expect(h.agentCreate).toHaveBeenCalledWith(expect.objectContaining({ useOwnCredits: true, currentCredits: 0 }));
    expect(h.subtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'transfer_credit',
        ownerId: 'user-1',
        credits: 30,
        recipientId: 'agent-1',
      }),
      expect.anything()
    );
    expect(h.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'received_credit', ownerId: 'agent-1', credits: 30, senderId: 'user-1' }),
      expect.anything()
    );
    expect(h.incrementCredits).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ currentCredits: 30, userCredits: 50 }));
  });

  it('refuses an allocation above the user balance without creating the agent or moving credits', async () => {
    const { run, json, status } = post({ name: 'Agent', useOwnCredits: true, currentCredits: 101 });

    await run();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: expect.stringMatching(/^Insufficient credits/) });
    expect(h.agentCreate).not.toHaveBeenCalled();
    expect(h.subtractCredits).not.toHaveBeenCalled();
    expect(h.addCredits).not.toHaveBeenCalled();
  });

  it('creates an unfunded agent at 0 credits whatever currentCredits the body carries', async () => {
    const { run, status } = post({ name: 'Agent', useOwnCredits: false, currentCredits: 1e9 });

    await run();

    expect(status).toHaveBeenCalledWith(201);
    expect(h.agentCreate).toHaveBeenCalledWith(expect.objectContaining({ useOwnCredits: false, currentCredits: 0 }));
    expect(h.subtractCredits).not.toHaveBeenCalled();
    expect(h.addCredits).not.toHaveBeenCalled();
  });

  it.each([-5, 'abc', Number.NaN])('rejects a funded create with currentCredits %s', async currentCredits => {
    const { run, json, status } = post({ name: 'Agent', useOwnCredits: true, currentCredits });

    await run();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'currentCredits must be a non-negative number' });
    expect(h.agentCreate).not.toHaveBeenCalled();
    expect(h.subtractCredits).not.toHaveBeenCalled();
  });

  it('answers 400 with the cap message at the tier cap and creates nothing', async () => {
    h.countByUserId.mockResolvedValue(10);
    const { res, json, status } = makeRes();

    await h.handler!({ user: { id: 'user-1' }, body: { name: 'Agent' } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Agent limit reached for your tier (10 max)' });
    expect(h.agentCreate).not.toHaveBeenCalled();
  });
});
