import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ users: vi.fn(), events: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { find: mocks.users },
  AuthEventModel: { find: mocks.events },
}));
import { findLinkedAdvisoryAccounts } from './linkedAdvisoryAccounts';

function query(rows: unknown[]) {
  const chain = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    maxTimeMS: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  for (const method of [chain.select, chain.sort, chain.limit, chain.maxTimeMS]) method.mockReturnValue(chain);
  return chain;
}

const now = new Date('2026-11-01T12:00:00Z');
const recent = new Date(now.getTime() - 60_000);
const busyIp = '198.51.100.10';
const rareIp = '203.0.113.20';
const id = (value: number) => value.toString(16).padStart(24, '0');

beforeEach(() => vi.resetAllMocks());

describe('bounded linked-account population retry', () => {
  it('returns a rare-IP candidate after excluding a busy IP proven to have more than 25 users', async () => {
    const seed = { _id: id(1), signupMeta: { ip: busyIp }, createdAt: recent };
    const candidate = { _id: id(2), name: 'Example candidate', signupMeta: { ip: rareIp } };
    mocks.users
      .mockReturnValueOnce(query([seed]))
      .mockReturnValueOnce(query([]))
      .mockReturnValueOnce(query([candidate]))
      .mockReturnValueOnce(query([candidate]));
    mocks.events
      .mockReturnValueOnce(query([{ userId: id(1), ip: rareIp, type: 'login' }]))
      .mockReturnValueOnce(
        query(
          Array.from({ length: 2_001 }, (_, index) => ({
            userId: id(100 + (index % 26)),
            ip: busyIp,
            type: 'login',
          }))
        )
      )
      .mockReturnValueOnce(query([]));

    expect(await findLinkedAdvisoryAccounts([id(1)], now)).toEqual({
      accounts: [
        {
          userId: id(2),
          name: 'Example candidate',
          links: [{ sourceUserId: id(1), ip: rareIp, sourceKind: 'login', candidateKind: 'signup' }],
        },
      ],
      truncated: false,
    });
    expect(mocks.users.mock.calls[2][0]['signupMeta.ip']).toEqual({ $in: [rareIp] });
    expect(mocks.events.mock.calls[2][0].ip).toEqual({ $in: [rareIp] });
    expect(mocks.events).toHaveBeenCalledTimes(3);
  });
});
