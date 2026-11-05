import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({
  markPurchaseReversed: vi.fn(),
  findUnreversedPurchase: vi.fn(),
  findById: vi.fn(),
  clearPurchaseStampIfUnchanged: vi.fn(),
  sendToClient: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: {
    markPurchaseReversed: mocks.markPurchaseReversed,
    findUnreversedPurchase: mocks.findUnreversedPurchase,
  },
  userRepository: { findById: mocks.findById, clearPurchaseStampIfUnchanged: mocks.clearPurchaseStampIfUnchanged },
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: mocks.sendToClient }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
vi.mock('@server/integrations/slack/subscriptionLifecycle', () => ({
  adminOwnerSlackRef: ({ ownerId }: { ownerId: string }) => `\`${ownerId}\``,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://ws.example.com' } } }));

import { reversePurchaseStanding } from './purchaseReversal';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const STAMP = new Date('2026-10-01T00:00:00Z');
const purchaseRow = { id: 'tx_1', ownerId: 'user_1', ownerType: CreditHolderType.User };
const reverse = () => reversePurchaseStanding({ paymentIntentId: 'pi_1', reason: 'refunded' }, logger);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markPurchaseReversed.mockResolvedValue(purchaseRow);
  mocks.findById.mockResolvedValue({ id: 'user_1', lastCreditsPurchasedAt: STAMP });
  mocks.findUnreversedPurchase.mockResolvedValue(null);
  mocks.clearPurchaseStampIfUnchanged.mockResolvedValue(true);
  mocks.sendToClient.mockResolvedValue(undefined);
});

describe('reversePurchaseStanding', () => {
  it('revokes the stamp the user was read with and refreshes their models and entitlements', async () => {
    expect(await reverse()).toBe('revoked');

    expect(mocks.markPurchaseReversed).toHaveBeenCalledWith('pi_1', 'refunded');
    expect(mocks.clearPurchaseStampIfUnchanged).toHaveBeenCalledWith('user_1', STAMP);
    expect(mocks.sendToClient.mock.calls.map(c => c[2].queryKey)).toEqual([['llm', 'models'], ['entitlements']]);
    expect(mocks.postMessageToSlack).toHaveBeenCalledOnce();
  });

  it('revokes on a redelivery of an already reversed purchase', async () => {
    mocks.markPurchaseReversed.mockResolvedValue({ ...purchaseRow, reversedAt: STAMP, reversalReason: 'refunded' });

    expect(await reverse()).toBe('revoked');
  });

  it('keeps the stamp while another unreversed purchase backs it', async () => {
    mocks.findUnreversedPurchase.mockResolvedValue({ id: 'tx_2' });

    expect(await reverse()).toBe('kept');
    expect(mocks.findUnreversedPurchase).toHaveBeenCalledWith('user_1', CreditHolderType.User);
    expect(mocks.clearPurchaseStampIfUnchanged).not.toHaveBeenCalled();
  });

  it('leaves the stamp when a purchase rewrote it after the read', async () => {
    mocks.clearPurchaseStampIfUnchanged.mockResolvedValue(false);

    expect(await reverse()).toBe('kept');
    expect(mocks.sendToClient).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('does nothing past the mark for an organization owner', async () => {
    mocks.markPurchaseReversed.mockResolvedValue({ ...purchaseRow, ownerType: CreditHolderType.Organization });

    expect(await reverse()).toBe('not_user');
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('does nothing when no purchase row carries the payment intent', async () => {
    mocks.markPurchaseReversed.mockResolvedValue(null);

    expect(await reverse()).toBe('no_purchase');
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('does nothing when the user holds no stamp', async () => {
    mocks.findById.mockResolvedValue({ id: 'user_1', lastCreditsPurchasedAt: null });

    expect(await reverse()).toBe('no_stamp');
    expect(mocks.clearPurchaseStampIfUnchanged).not.toHaveBeenCalled();
  });

  it('still reports the revocation when the Slack alert fails', async () => {
    mocks.postMessageToSlack.mockRejectedValueOnce(new Error('slack down'));

    expect(await reverse()).toBe('revoked');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('throws on a DB failure so the webhook fails the delivery', async () => {
    mocks.markPurchaseReversed.mockRejectedValue(new Error('mongo down'));

    await expect(reverse()).rejects.toThrow('mongo down');
  });
});
