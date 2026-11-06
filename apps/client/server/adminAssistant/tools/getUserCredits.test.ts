import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminUserRef = vi.fn();
vi.mock('../resolveAdminUserRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../resolveAdminUserRef')>()),
  resolveAdminUserRef: (...args: unknown[]) => resolveAdminUserRef(...args),
}));
const buildActorDirectory = vi.fn();
vi.mock('../../utils/userActivity', () => ({
  buildActorDirectory: (...args: unknown[]) => buildActorDirectory(...args),
}));
const findByOwnerWithFilters = vi.fn();
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { findByOwnerWithFilters: (...args: unknown[]) => findByOwnerWithFilters(...args) },
}));

import { getUserCreditsTool } from './getUserCredits';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runRaw = (args: unknown) => getUserCreditsTool.implementation(context, undefined).toolFn(args);
const runTool = async (args: unknown) => JSON.parse(await runRaw(args));

const transaction = (extra: Record<string, unknown> = {}) => ({
  id: 't1',
  type: 'generic_add',
  credits: 100,
  reason: 'admin_adjustment',
  description: 'goodwill',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  stripePaymentIntentId: 'pi_secret_123',
  metadata: { internalNote: 'raw-metadata-value' },
  ...extra,
});

describe('getUserCreditsTool', () => {
  beforeEach(() => {
    resolveAdminUserRef.mockReset().mockResolvedValue({ id: USER_ID, currentCredits: 42 });
    findByOwnerWithFilters.mockReset().mockResolvedValue([]);
    buildActorDirectory.mockReset().mockResolvedValue(new Map());
  });

  it('returns not_found for an unknown user', async () => {
    resolveAdminUserRef.mockResolvedValue(null);

    expect(await runTool({ email: 'nobody@example.com' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it.each([{ days: 91 }, { days: 0 }, { limit: 51 }, { limit: 0 }])('rejects %o as invalid_input', async extra => {
    expect(await runTool({ userId: USER_ID, ...extra })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(findByOwnerWithFilters).not.toHaveBeenCalled();
  });

  it('returns the current balance and picked transaction fields with defaults', async () => {
    findByOwnerWithFilters.mockResolvedValue([transaction()]);

    const result = await runTool({ userId: USER_ID });

    expect(findByOwnerWithFilters).toHaveBeenCalledWith(USER_ID, 'User', {
      days: 30,
      transactionTypes: ['generic_add', 'generic_deduct'],
      limit: 21,
    });
    expect(result.data).toEqual({
      balance: 42,
      truncated: false,
      transactions: [
        {
          at: '2026-10-01T00:00:00.000Z',
          type: 'generic_add',
          amount: 100,
          reason: 'admin_adjustment',
          actorName: 'Unknown admin',
        },
      ],
    });
  });

  it('omits stripePaymentIntentId and raw metadata', async () => {
    findByOwnerWithFilters.mockResolvedValue([transaction({ type: 'purchase' })]);

    const raw = await runRaw({ userId: USER_ID, includePurchases: true });

    for (const leaked of ['pi_secret_123', 'stripePaymentIntentId', 'raw-metadata-value', 'metadata']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('excludes purchases and subscriptions unless asked', async () => {
    await runTool({ userId: USER_ID, days: 7, limit: 5 });
    expect(findByOwnerWithFilters).toHaveBeenLastCalledWith(USER_ID, 'User', {
      days: 7,
      transactionTypes: ['generic_add', 'generic_deduct'],
      limit: 6,
    });

    await runTool({ userId: USER_ID, includePurchases: true });
    expect(findByOwnerWithFilters).toHaveBeenLastCalledWith(
      USER_ID,
      'User',
      expect.objectContaining({ transactionTypes: ['generic_add', 'generic_deduct', 'purchase', 'subscription'] })
    );
  });

  it('adds the admin note and actor display name for admin_adjustment rows only', async () => {
    buildActorDirectory.mockResolvedValue(new Map([['admin-9', { name: 'Grace Admin', email: 'grace@example.com' }]]));
    findByOwnerWithFilters.mockResolvedValue([
      transaction({ metadata: { actorId: 'admin-9', note: 'goodwill credit', internalNote: 'raw-metadata-value' } }),
      transaction({
        id: 't2',
        type: 'generic_deduct',
        credits: -5,
        reason: 'credit_expiry',
        metadata: { actorId: 'admin-9', note: 'should not surface' },
      }),
    ]);

    const raw = await runRaw({ userId: USER_ID });
    const { transactions } = JSON.parse(raw).data;

    expect(buildActorDirectory).toHaveBeenCalledWith(['admin-9']);
    expect(transactions[0]).toMatchObject({
      reason: 'admin_adjustment',
      note: 'goodwill credit',
      actorName: 'Grace Admin',
    });
    expect(transactions[1]).toEqual({
      at: '2026-10-01T00:00:00.000Z',
      type: 'generic_deduct',
      amount: -5,
      reason: 'credit_expiry',
    });
    for (const leaked of ['grace@example.com', 'admin-9', 'raw-metadata-value', 'should not surface']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('reports truncated when more rows exist than the limit', async () => {
    findByOwnerWithFilters.mockResolvedValue([transaction({ id: 'a' }), transaction({ id: 'b' })]);

    const result = await runTool({ userId: USER_ID, limit: 1 });

    expect(result.data.transactions).toHaveLength(1);
    expect(result.data.truncated).toBe(true);
  });

  it('hands the model userId, email and the tool fields in its JSON schema', () => {
    const { parameters } = getUserCreditsTool.implementation(context, undefined).toolSchema;

    expect((parameters as { required?: string[] }).required ?? []).not.toContain('days');
    expect(Object.keys((parameters as { properties: object }).properties)).toEqual([
      'userId',
      'email',
      'days',
      'limit',
      'includePurchases',
    ]);
  });
});
