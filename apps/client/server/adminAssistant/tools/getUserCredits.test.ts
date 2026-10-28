import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminUserRef = vi.fn();
vi.mock('../resolveAdminUserRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../resolveAdminUserRef')>()),
  resolveAdminUserRef: (...args: unknown[]) => resolveAdminUserRef(...args),
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
      limit: 20,
    });
    expect(result.data).toEqual({
      balance: 42,
      transactions: [{ at: '2026-10-01T00:00:00.000Z', type: 'generic_add', amount: 100, reason: 'admin_adjustment' }],
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
      limit: 5,
    });

    await runTool({ userId: USER_ID, includePurchases: true });
    expect(findByOwnerWithFilters).toHaveBeenLastCalledWith(
      USER_ID,
      'User',
      expect.objectContaining({ transactionTypes: ['generic_add', 'generic_deduct', 'purchase', 'subscription'] })
    );
  });

  it('hands the model userId, email and the tool fields in its JSON schema', () => {
    const { parameters } = getUserCreditsTool.implementation(context, undefined).toolSchema;

    expect(Object.keys((parameters as { properties: object }).properties)).toEqual([
      'userId',
      'email',
      'days',
      'limit',
      'includePurchases',
    ]);
  });
});
