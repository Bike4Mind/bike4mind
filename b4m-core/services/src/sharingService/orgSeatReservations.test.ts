import { describe, expect, it } from 'vitest';
import { InviteType, type IInviteDocument } from '@bike4mind/common';
import { pendingOrgInviteRecipients } from './orgSeatReservations';

const invite = (overrides: Record<string, unknown>) =>
  ({
    type: InviteType.Organization,
    remaining: 1,
    recipients: { pending: [] },
    ...overrides,
  }) as unknown as IInviteDocument;

describe('pendingOrgInviteRecipients', () => {
  it('counts each live pending address once, across invites and casing', () => {
    const now = new Date();
    const result = pendingOrgInviteRecipients(
      [
        invite({ remaining: 2, recipients: { pending: ['a@x.com', ' B@x.com'] } }),
        invite({ expiresAt: new Date(now.getTime() + 60_000), recipients: { pending: ['b@x.com'] } }),
        invite({ expiresAt: new Date(now.getTime() - 60_000), recipients: { pending: ['expired@x.com'] } }),
        invite({ remaining: 0, recipients: { pending: ['spent@x.com'] } }),
        invite({ revokedAt: now, recipients: { pending: ['revoked@x.com'] } }),
        invite({ type: InviteType.Group, recipients: { pending: ['group@x.com'] } }),
      ],
      now
    );
    expect(result.sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});
