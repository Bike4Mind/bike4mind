import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  reportKeptPersonalLakeShares: vi.fn(),
  notifyKeptPersonalLakeShares: vi.fn(),
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
  dataLakes: { kind: 'dataLakes' },
  dataLakeAccessGrants: { kind: 'dataLakeAccessGrants' },
  users: { kind: 'users', findByIds: vi.fn(), findActiveEmailsByIds: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    reportKeptPersonalLakeShares: h.reportKeptPersonalLakeShares,
    notifyKeptPersonalLakeShares: h.notifyKeptPersonalLakeShares,
  },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: h.dataLakes,
  dataLakeAccessGrantRepository: h.dataLakeAccessGrants,
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: h.users }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));

import { reportAndNotifyKeptPersonalLakeShares } from './keptPersonalLakeSharesNotifier';

const ORG = {
  id: 'org-1',
  name: 'Acme',
  userId: 'owner-1',
  users: [
    { userId: 'member-2', permissions: ['read'] },
    // 'share' is a real Permission value, just not one of the two that confer membership.
    { userId: 'viewer-3', permissions: ['share'] },
  ],
};

describe('reportAndNotifyKeptPersonalLakeShares', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.reportKeptPersonalLakeShares.mockResolvedValue({ lakeCount: 0, byOwner: [] });
    h.notifyKeptPersonalLakeShares.mockResolvedValue(undefined);
  });

  it('derives member ids from the org doc: the billing owner plus users[] rows conferring membership', async () => {
    await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    expect(h.reportKeptPersonalLakeShares).toHaveBeenCalledWith(
      'departed-1',
      ['owner-1', 'member-2'],
      expect.anything()
    );
  });

  it('excludes a users[] row without a membership-conferring permission', async () => {
    await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    const [, memberIds] = h.reportKeptPersonalLakeShares.mock.calls[0];
    expect(memberIds).not.toContain('viewer-3');
  });

  it('returns null and logs at error level when the report read fails, without notifying', async () => {
    h.reportKeptPersonalLakeShares.mockRejectedValue(new Error('db down'));
    const error = vi.fn();
    const logger = { error, warn: vi.fn() } as unknown as Logger;

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG, logger);

    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ departedUserId: 'departed-1', organizationName: 'Acme' })
    );
    expect(h.notifyKeptPersonalLakeShares).not.toHaveBeenCalled();
  });

  it('returns the kept-share count and notifies owners on a successful report', async () => {
    const shares = { lakeCount: 2, byOwner: [{ ownerUserId: 'owner-1', lakes: [{ id: 'l1', name: 'Lake' }] }] };
    h.reportKeptPersonalLakeShares.mockResolvedValue(shares);

    const result = await reportAndNotifyKeptPersonalLakeShares('departed-1', ORG);

    expect(result).toBe(2);
    expect(h.notifyKeptPersonalLakeShares).toHaveBeenCalledWith(
      shares,
      expect.objectContaining({ departedUserId: 'departed-1', organizationName: 'Acme' }),
      expect.anything()
    );
  });
});

describe('reportAndNotifyKeptPersonalLakeShares through the queued mailer', () => {
  const shares = {
    lakeCount: 2,
    byOwner: [
      {
        ownerUserId: 'owner-1',
        lakes: [
          { id: 'lake-1', name: 'Lake A' },
          { id: 'lake-2', name: 'Lake B' },
        ],
      },
      { ownerUserId: 'owner-2', lakes: [{ id: 'lake-3', name: 'Lake C' }] },
    ],
  };

  let realNotify: typeof import('@bike4mind/services').dataLakeService.notifyKeptPersonalLakeShares;
  beforeAll(async () => {
    const { dataLakeService } = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
    realNotify = dataLakeService.notifyKeptPersonalLakeShares;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('B4M_SELF_HOST', 'false');
    h.notifyKeptPersonalLakeShares.mockImplementation(realNotify);
    h.reportKeptPersonalLakeShares.mockResolvedValue(shares);
    h.users.findByIds.mockResolvedValue([{ id: 'departed-1', name: 'Dana Departed' }]);
    h.users.findActiveEmailsByIds.mockResolvedValue([
      { id: 'owner-1', email: 'first@example.org' },
      { id: 'owner-2', email: 'second@example.org' },
    ]);
    h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('publishes one email.send event per lake owner naming the departed member and the lakes', async () => {
    await expect(reportAndNotifyKeptPersonalLakeShares('departed-1', ORG)).resolves.toBe(2);

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'first@example.org',
        subject: expect.stringContaining('Dana Departed has left Acme'),
        body: expect.stringContaining('Lake B'),
      })
    );
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'second@example.org', body: expect.stringContaining('Lake C') })
    );
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('warns about the owners it could not queue mail for, without failing the departure', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    h.publish.mockRejectedValue(new Error('bus unreachable'));
    const warn = vi.fn();
    const logger = { error: vi.fn(), warn } as unknown as Logger;

    await expect(reportAndNotifyKeptPersonalLakeShares('departed-1', ORG, logger)).resolves.toBe(2);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some kept-personal-lake-share emails failed'), {
      failed: 2,
    });
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });
});
