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

const getCallerModelList = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/callerModelList', () => ({ getCallerModelList }));

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
    const warn = vi.fn();
    const error = vi.fn();
    return {
      ...r,
      warn,
      error,
      run: () => h.handler!({ user: { id: 'user-1' }, body, logger: { warn, error } }, r.res),
    };
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

  it('fails with 400 and does not credit the agent when the user debit finds no user', async () => {
    h.subtractCredits.mockResolvedValue(null);
    const { run, json, status, warn, error } = post({ name: 'Agent', useOwnCredits: true, currentCredits: 30 });

    await run();

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'User not found' });
    expect(h.addCredits).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails the create when crediting the agent finds no agent', async () => {
    h.subtractCredits.mockResolvedValue({ id: 'user-1', currentCredits: 70 });
    h.addCredits.mockResolvedValue(null);
    const { run, json, status, warn, error } = post({ name: 'Agent', useOwnCredits: true, currentCredits: 30 });

    await run();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ details: 'Failed to fund agent credits' }));
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 503 and logs at error when the model catalog is empty', async () => {
    getCallerModelList.mockResolvedValue({ models: [], supersededModels: [] });
    const { run, status, warn, error } = post({ name: 'Agent', preferredModel: 'gpt-9-nope' });

    await run();

    expect(status).toHaveBeenCalledWith(503);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(h.agentCreate).not.toHaveBeenCalled();
  });

  it('answers 500 when the model catalog lookup fails', async () => {
    getCallerModelList.mockRejectedValue(new Error('catalog down'));
    const { run, status, error } = post({ name: 'Agent', preferredModel: 'gpt-9-nope' });

    await run();

    expect(status).toHaveBeenCalledWith(500);
    expect(error).toHaveBeenCalledTimes(1);
    expect(h.agentCreate).not.toHaveBeenCalled();
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

    await h.handler!(
      { user: { id: 'user-1' }, body: { name: 'Agent' }, logger: { warn: vi.fn(), error: vi.fn() } },
      res
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Agent limit reached for your tier (10 max)' });
    expect(h.agentCreate).not.toHaveBeenCalled();
  });
});
