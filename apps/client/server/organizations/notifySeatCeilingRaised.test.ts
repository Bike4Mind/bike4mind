import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostToSlack = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostToSlack(...args),
}));

vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_SEAT_CEILING_RAISED: 'ORG_SEAT_CEILING_RAISED' },
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

import {
  auditSeatCeilingRaised,
  notifySeatCeilingRaised,
  notifyPartnerSignupBlockedAtCapacity,
} from './notifySeatCeilingRaised';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('auditSeatCeilingRaised', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockPostToSlack.mockResolvedValue(undefined);
  });

  it('writes the ORG_SEAT_CEILING_RAISED audit event and does NOT post to Slack', async () => {
    await auditSeatCeilingRaised(
      { organizationId: 'org-1', userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'otc-signup' },
      logger
    );

    expect(mockPostToSlack).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'ORG_SEAT_CEILING_RAISED',
        metadata: { organizationId: 'org-1', previousSeats: 2, newSeats: 3, trigger: 'otc-signup' },
      }),
      logger
    );
    // No admin actor on a live signup.
    expect(mockLogAuditEvent.mock.calls[0][0]).not.toHaveProperty('adminUserId');
  });

  it('records the acting admin as the audit actor for a bulk backfill raise', async () => {
    await auditSeatCeilingRaised(
      {
        organizationId: 'org-1',
        userId: 'user-1',
        previousSeats: 4,
        newSeats: 5,
        trigger: 'admin-backfill',
        actingAdminId: 'admin-9',
      },
      logger
    );

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: 'admin-9',
        metadata: expect.objectContaining({ trigger: 'admin-backfill' }),
      }),
      logger
    );
  });
});

describe('notifySeatCeilingRaised', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAuditEvent.mockResolvedValue(undefined);
    mockPostToSlack.mockResolvedValue(undefined);
  });

  it('posts the Slack alert AND writes the audit event for a live signup raise', async () => {
    await notifySeatCeilingRaised(
      { organizationId: 'org-1', userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'email-verification' },
      logger
    );

    expect(mockPostToSlack).toHaveBeenCalledTimes(1);
    expect(mockPostToSlack.mock.calls[0][0]).toContain('2 -> 3');
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('never throws when Slack fails - a signup already committed must not be broken', async () => {
    mockPostToSlack.mockRejectedValue(new Error('slack down'));

    await expect(
      notifySeatCeilingRaised(
        { organizationId: 'org-1', userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'otc-signup' },
        logger
      )
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('notifyPartnerSignupBlockedAtCapacity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostToSlack.mockResolvedValue(undefined);
  });

  it('posts a Slack alert naming the blocked user and the full ceiling', async () => {
    await notifyPartnerSignupBlockedAtCapacity(
      { organizationId: 'org-1', userId: 'user-1', seats: 2, trigger: 'otc-signup' },
      logger
    );

    expect(mockPostToSlack).toHaveBeenCalledTimes(1);
    const message = mockPostToSlack.mock.calls[0][0] as string;
    expect(message).toContain('user-1');
    expect(message).toContain('2');
  });

  it('never throws when Slack fails', async () => {
    mockPostToSlack.mockRejectedValue(new Error('slack down'));

    await expect(
      notifyPartnerSignupBlockedAtCapacity(
        { organizationId: 'org-1', userId: 'user-1', seats: 2, trigger: 'email-verification' },
        logger
      )
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
