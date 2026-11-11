import { describe, it, expect, vi, beforeEach } from 'vitest';

const publish = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

import {
  buildNewOwnerEmail,
  buildPreviousOwnerEmail,
  sendOwnershipTransferEmails,
  type OwnershipTransferEmailInput,
} from './ownershipTransferEmail';

const input = (over: Partial<OwnershipTransferEmailInput> = {}): OwnershipTransferEmailInput => ({
  organizationName: 'Acme',
  organizationUrl: 'https://app.example.com/organizations/org1',
  previousOwner: { email: 'old@example.com', name: 'Olivia' },
  newOwner: { email: 'new@example.com', name: 'Nadia' },
  ...over,
});

describe('ownershipTransferEmail', () => {
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    publish.mockResolvedValue(undefined);
  });

  it('tells the new owner who handed them the team and that billing is now theirs', () => {
    const email = buildNewOwnerEmail(input());
    expect(email.subject).toBe('You are now the owner of Acme');
    expect(email.body).toContain('Olivia transferred ownership of <strong>Acme</strong> to you');
    expect(email.body).toContain('billing owner');
  });

  it('tells the former owner who owns it now and that they can leave', () => {
    const email = buildPreviousOwnerEmail(input());
    expect(email.subject).toBe('Ownership of Acme was transferred');
    expect(email.body).toContain('transferred to Nadia');
    expect(email.body).toContain('leave');
  });

  it('escapes the team name in the body and strips line breaks from the subject', () => {
    const email = buildNewOwnerEmail(input({ organizationName: '<b>Evil</b>\r\nBcc: x@example.com' }));
    expect(email.body).not.toContain('<b>Evil</b>');
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it('falls back to the email when a party has no name', () => {
    const email = buildNewOwnerEmail(input({ previousOwner: { email: 'old@example.com', name: '' } }));
    expect(email.body).toContain('old@example.com transferred ownership');
  });

  it('sends one email to each party', async () => {
    await sendOwnershipTransferEmails(input(), logger as never);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ to: 'old@example.com' }));
  });

  it('skips a party with no address and never throws when a send fails', async () => {
    publish.mockRejectedValue(new Error('bus down'));
    await expect(
      sendOwnershipTransferEmails(input({ previousOwner: { email: null, name: null } }), logger as never)
    ).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'bus down' });
  });
});
