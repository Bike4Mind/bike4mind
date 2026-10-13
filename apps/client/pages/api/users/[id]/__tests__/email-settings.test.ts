import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindOne, mockFindById, mockUpdate } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.patch = (fn: unknown) => {
      chain.patchFn = fn;
      return chain;
    };
    chain.get = () => chain;
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...a: unknown[]) => mockFindOne(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
    findByIdAndUpdate: (...a: unknown[]) => mockUpdate(...a),
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));

import handler from '../email-settings';

const patch = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'PATCH', query: { id: 'u1' }, body });
  Object.assign(req, { user: { id: 'u1' } });
  const fn = (handler as unknown as { patchFn: (q: unknown, s: unknown) => Promise<void> }).patchFn;
  await fn(req, res);
  return res;
};

const stored = (platformEmailAddress: string | null) => ({
  select: () => Promise.resolve({ platformEmailAddress }),
});

describe('email-settings platformEmailAddress local part', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockUpdate.mockReturnValue({
      select: () => Promise.resolve({ platformEmailAddress: 'x', authorizedEmailAddresses: [] }),
    });
  });

  it('rejects a new reserved local part case-insensitively', async () => {
    mockFindById.mockReturnValue(stored(null));
    for (const address of [
      'admin@example.com',
      'Postmaster@example.com',
      'NO-REPLY@example.com',
      'Sales@example.com',
    ]) {
      const res = await patch({ platformEmailAddress: address });
      expect(res._getStatusCode()).toBe(400);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('accepts a non-reserved local part', async () => {
    mockFindById.mockReturnValue(stored(null));
    const res = await patch({ platformEmailAddress: 'Jane.Doe@example.com' });
    expect(res._getStatusCode()).toBe(200);
  });

  it('keeps an already-held reserved address editable when saved unchanged', async () => {
    mockFindById.mockReturnValue(stored('info@example.com'));
    const res = await patch({ platformEmailAddress: 'info@example.com', authorizedEmailAddresses: ['a@example.com'] });
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });
});
