import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_ORG_TRANSFER_REQUIRED, ConflictError } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  markDeletionRequested: vi.fn(),
  findOrgs: vi.fn(),
  revokeUserSessions: vi.fn(),
  cancelAccountSubscriptions: vi.fn(),
  revokeAppleTokens: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: mocks.findById, markDeletionRequested: mocks.markDeletionRequested },
  organizationRepository: { find: mocks.findOrgs },
  authSessionRepository: {},
  realtimeConnectionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: { revokeUserSessions: mocks.revokeUserSessions } }));
vi.mock('@bike4mind/server-utils/auth/revokeAppleTokens', () => ({ revokeAppleTokens: mocks.revokeAppleTokens }));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: mocks.cancelAccountSubscriptions,
}));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: mocks.publish } } }));

import { requestAccountDeletion } from './requestAccountDeletion';

const USER_ID = '665f1c2e8b3a4d0012345678';
const OTHER_ID = '665f1c2e8b3a4d0087654321';
const ORG_ID = '665f1c2e8b3a4d00aaaaaaaa';
const NOW = new Date('2026-03-01T00:00:00.000Z');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const request = () => requestAccountDeletion(USER_ID, { logger, now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, email: 'owner@example.com', name: 'Owner <b>' });
  mocks.findOrgs.mockResolvedValue([]);
  mocks.markDeletionRequested.mockResolvedValue({ deletionRequestedAt: NOW, newlyMarked: true });
  mocks.revokeUserSessions.mockResolvedValue(undefined);
  mocks.cancelAccountSubscriptions.mockResolvedValue({ canceled: ['sub_1'], failed: [] });
  mocks.revokeAppleTokens.mockResolvedValue({ status: 'no_token' });
  mocks.publish.mockResolvedValue(undefined);
});

describe('requestAccountDeletion', () => {
  it('refuses a sole owner of an organization with other members, and changes nothing', async () => {
    mocks.findOrgs.mockResolvedValue([
      { id: ORG_ID, name: 'Shared Org', users: [{ userId: USER_ID }, { userId: OTHER_ID }], adminUserIds: [] },
    ]);

    const error = await request().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).additionalInfo).toEqual({
      code: ACCOUNT_DELETION_ORG_TRANSFER_REQUIRED,
      organizations: [{ id: ORG_ID, name: 'Shared Org' }],
    });
    expect(mocks.markDeletionRequested).not.toHaveBeenCalled();
    expect(mocks.revokeUserSessions).not.toHaveBeenCalled();
    expect(mocks.cancelAccountSubscriptions).not.toHaveBeenCalled();
  });

  it('counts an org admin as another member', async () => {
    mocks.findOrgs.mockResolvedValue([
      { id: ORG_ID, name: 'Org', users: [{ userId: USER_ID }], adminUserIds: [OTHER_ID] },
    ]);
    await expect(request()).rejects.toBeInstanceOf(ConflictError);
  });

  it('allows the owner of a sole-member organization (the org goes with the account later)', async () => {
    mocks.findOrgs.mockResolvedValue([
      { id: ORG_ID, name: 'Solo', users: [{ userId: USER_ID }], adminUserIds: [USER_ID] },
    ]);

    const result = await request();

    expect(result.deletionScheduledFor.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(mocks.markDeletionRequested).toHaveBeenCalledWith(USER_ID, NOW);
  });

  it('revokes every session, cancels Stripe subscriptions and mails a confirmation', async () => {
    const result = await request();

    expect(mocks.revokeUserSessions).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ db: expect.any(Object) }));
    expect(mocks.cancelAccountSubscriptions).toHaveBeenCalledWith(
      { userId: USER_ID, reason: 'account_deletion_requested' },
      logger
    );
    expect(mocks.publish).toHaveBeenCalledOnce();
    const email = mocks.publish.mock.calls[0][0] as { to: string; subject: string; body: string };
    expect(email.to).toBe('owner@example.com');
    expect(email.subject).toMatch(/scheduled for deletion/);
    expect(email.body).toContain('Owner &lt;b&gt;');
    expect(result).toMatchObject({ newlyRequested: true, canceledSubscriptions: ['sub_1'] });
  });

  it('revokes the Apple grant when one exists', async () => {
    mocks.revokeAppleTokens.mockResolvedValue({ status: 'revoked' });
    await request();
    expect(mocks.revokeAppleTokens).toHaveBeenCalledWith(USER_ID);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Revoked the Apple grant'));
  });

  it('skips the Apple revocation quietly when the account has no Apple identity', async () => {
    await request();
    expect(mocks.revokeAppleTokens).toHaveBeenCalledWith(USER_ID);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Apple'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still schedules the deletion when Apple revocation or the email fails', async () => {
    mocks.revokeAppleTokens.mockRejectedValue(new Error('apple down'));
    mocks.publish.mockRejectedValue(new Error('bus down'));

    await expect(request()).resolves.toMatchObject({ newlyRequested: true });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('apple down'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bus down'));
  });

  it('is idempotent: a repeat keeps the first request time, re-revokes, and sends no second email', async () => {
    const firstRequest = new Date('2026-02-20T00:00:00.000Z');
    mocks.markDeletionRequested.mockResolvedValue({ deletionRequestedAt: firstRequest, newlyMarked: false });

    const result = await request();

    expect(result.deletionRequestedAt).toBe(firstRequest);
    expect(result.newlyRequested).toBe(false);
    expect(mocks.revokeUserSessions).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('404s for a missing user', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(request()).rejects.toThrow('User not found');
  });
});
