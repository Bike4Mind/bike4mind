import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware stripped so the handler body runs directly (same pattern as
// __tests__/model-prices.test.ts). The chain object doubles as the exported
// handler and dispatches on req.method.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    return chain;
  },
}));

const mockNewest = vi.fn();
const mockAppend = vi.fn();
vi.mock('@bike4mind/database', () => ({
  providerInvoiceRepository: {
    newestPerMonthProvider: (...a: unknown[]) => mockNewest(...a),
    append: (...a: unknown[]) => mockAppend(...a),
  },
}));

import handler from '../provider-invoices';

const BODY = { month: '2026-06', provider: 'openai', invoiceUsd: 412.3, note: 'INV-1, Jun 1-30' };

function call(options: { method: 'GET' | 'POST'; isAdmin?: boolean; body?: object }) {
  const { req, res } = createMocks({ method: options.method, body: options.body });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/provider-invoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin users', async () => {
    const { run } = call({ method: 'GET', isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockNewest).not.toHaveBeenCalled();
  });

  it('returns the newest row per month and provider', async () => {
    mockNewest.mockResolvedValue([{ ...BODY, enteredBy: 'admin-1' }]);
    const { res, run } = call({ method: 'GET' });
    await run();
    expect(res._getJSONData().invoices).toHaveLength(1);
  });
});

describe('POST /api/admin/provider-invoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin users', async () => {
    const { run } = call({ method: 'POST', isAdmin: false, body: BODY });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('appends with the requesting admin as enteredBy', async () => {
    mockAppend.mockResolvedValue({ ...BODY, enteredBy: 'admin-1' });
    const { res, run } = call({ method: 'POST', body: BODY });
    await run();
    expect(mockAppend).toHaveBeenCalledWith({ ...BODY, enteredBy: 'admin-1' });
    expect(res._getJSONData().invoice.enteredBy).toBe('admin-1');
  });

  it('rejects a malformed month as a 400', async () => {
    const { run } = call({ method: 'POST', body: { ...BODY, month: 'June' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects negative and non-finite amounts as a 400', async () => {
    await expect(call({ method: 'POST', body: { ...BODY, invoiceUsd: -1 } }).run()).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(call({ method: 'POST', body: { ...BODY, invoiceUsd: 'lots' } }).run()).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects a blank note as a 400', async () => {
    const { run } = call({ method: 'POST', body: { ...BODY, note: '   ' } });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('trims the note before appending', async () => {
    mockAppend.mockResolvedValue({ ...BODY, enteredBy: 'admin-1' });
    const { run } = call({ method: 'POST', body: { ...BODY, note: '  INV-1, Jun 1-30  ' } });
    await run();
    expect(mockAppend).toHaveBeenCalledWith({ ...BODY, enteredBy: 'admin-1' });
  });
});
