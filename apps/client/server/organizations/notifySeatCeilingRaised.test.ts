import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostToSlack = vi.fn();
const mockRecordAdminAction = vi.fn();
const mockFindUserById = vi.fn();

vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostToSlack(...args),
}));

vi.mock('@bike4mind/services', () => ({
  adminAuditService: { recordAdminAction: (...args: unknown[]) => mockRecordAdminAction(...args) },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findById: (id: string) => mockFindUserById(id) } }));
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

  it('records the acting admin as the actor with source script for a bulk backfill raise', async () => {
    mockFindUserById.mockResolvedValue({ id: 'admin-9', name: 'Ada', email: 'ada@example.test' });
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

    const input = mockRecordAdminAction.mock.calls[0][0];
    expect(input.actor).toEqual(
      expect.objectContaining({ kind: 'user', userId: 'admin-9', name: 'Ada', wasAdmin: true })
    );
    expect(input.context).toEqual({ source: 'script' });
    expect(input.details).not.toHaveProperty('actingAdminId');
  });

  it('falls back to an unknown-admin actor and logs when the admin lookup rejects', async () => {
    mockFindUserById.mockRejectedValueOnce(new Error('db down'));
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

    expect(mockRecordAdminAction.mock.calls[0][0].actor).toEqual(
      expect.objectContaining({ userId: 'admin-9', name: 'Unknown admin' })
    );
    expect(logger.error).toHaveBeenCalledWith('[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]', expect.anything());
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
    mockPostToSlack.mockRejectedValueOnce(new Error('slack down'));

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
    mockPostToSlack.mockRejectedValueOnce(new Error('slack down'));

    await expect(
      notifyPartnerSignupBlockedAtCapacity(
        { organizationId: 'org-1', userId: 'user-1', seats: 2, trigger: 'email-verification' },
        logger
      )
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
