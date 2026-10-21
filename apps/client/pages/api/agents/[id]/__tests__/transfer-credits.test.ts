import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | Handler }));

vi.mock('@client/server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const agentFindById = vi.hoisted(() => vi.fn());
const userFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: agentFindById },
  userRepository: { findById: userFindById },
  creditTransactionRepository: {},
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));

const creditServiceMock = vi.hoisted(() => ({ addCredits: vi.fn(), subtractCredits: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ creditService: creditServiceMock }));

vi.mock('@server/agents/agentScopes', () => ({ AGENTS_WRITE_SCOPES: [] }));

import '@pages/api/agents/[id]/transfer-credits';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

const AGENT = { id: 'a1', name: 'Scout', userId: 'owner', users: [{ userId: 'u1' }] };

function invoke(userId: string) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'a1' }, body: { amount: 10 } });
  Object.assign(req, { user: { id: userId } });
  return { res, run: () => mockRefs.postHandler!(req, res) };
}

describe('POST /api/agents/[id]/transfer-credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFindById.mockResolvedValue(AGENT);
    userFindById.mockResolvedValue({ id: 'owner', currentCredits: 100 });
  });

  it('refuses a shared viewer with ForbiddenError and moves no credits', async () => {
    await expect(invoke('u1').run()).rejects.toBeInstanceOf(ForbiddenError);
    expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
    expect(creditServiceMock.addCredits).not.toHaveBeenCalled();
  });

  it('refuses a stranger with NotFoundError and moves no credits', async () => {
    await expect(invoke('stranger').run()).rejects.toBeInstanceOf(NotFoundError);
    expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
    expect(creditServiceMock.addCredits).not.toHaveBeenCalled();
  });

  it('transfers credits for the owner', async () => {
    creditServiceMock.subtractCredits.mockResolvedValue({ currentCredits: 90 });
    creditServiceMock.addCredits.mockResolvedValue({ currentCredits: 10 });
    const { res, run } = invoke('owner');
    await run();
    expect(creditServiceMock.subtractCredits).toHaveBeenCalledTimes(1);
    expect(res._getJSONData()).toMatchObject({ success: true, userCredits: 90, agentCredits: 10 });
  });
});
