import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostToSlack = vi.fn();
const mockRecordAdminAction = vi.fn();

vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostToSlack(...args),
}));

vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: (...args: unknown[]) => mockRecordAdminAction(...args) },
}));
vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository: { append: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({
  systemAuditActor: (name: string) => ({ kind: 'system', scope: 'platform', name, wasAdmin: false }),
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
    mockRecordAdminAction.mockResolvedValue(undefined);
    mockPostToSlack.mockResolvedValue(undefined);
  });

  it('writes the org.seats.ceiling_raised audit entry as the system actor and does NOT post to Slack', async () => {
    await auditSeatCeilingRaised(
      { organizationId: 'org-1', userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'otc-signup' },
      logger
    );

    expect(mockPostToSlack).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.seats.ceiling_raised',
        actor: expect.objectContaining({ kind: 'system', name: 'Seat ceiling' }),
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        context: { source: 'worker' },
        details: { userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'otc-signup' },
      }),
      expect.objectContaining({ logger })
    );
    expect(mockRecordAdminAction.mock.calls[0][0].details).not.toHaveProperty('actingAdminId');
  });

  it('records the acting admin in the details of a bulk backfill raise', async () => {
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

    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'system' }),
        details: expect.objectContaining({ actingAdminId: 'admin-9', trigger: 'admin-backfill' }),
      }),
      expect.objectContaining({ logger })
    );
  });
});

describe('notifySeatCeilingRaised', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordAdminAction.mockResolvedValue(undefined);
    mockPostToSlack.mockResolvedValue(undefined);
  });

  it('posts the Slack alert AND writes the audit event for a live signup raise', async () => {
    await notifySeatCeilingRaised(
      { organizationId: 'org-1', userId: 'user-1', previousSeats: 2, newSeats: 3, trigger: 'email-verification' },
      logger
    );

    expect(mockPostToSlack).toHaveBeenCalledTimes(1);
    expect(mockPostToSlack.mock.calls[0][0]).toContain('2 -> 3');
    expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
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
