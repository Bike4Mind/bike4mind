import { InviteType, Permission } from '@bike4mind/common';
import type { ISharerInviteView } from '@client/app/utils/invitesAPICalls';
import { describe, expect, it } from 'vitest';
import { buildPendingInviteRows } from './pendingInviteRows';

const USER_ID = '64b7f0a1c2d3e4f5a6b7c8d9';
const INVITER_ID = '64b7f0a1c2d3e4f5a6b7c8e0';

const invite = (over: Partial<ISharerInviteView> & Record<string, unknown> = {}): ISharerInviteView =>
  ({
    id: 'inv1',
    type: InviteType.Organization,
    documentId: 'org1',
    permissions: [Permission.read],
    recipients: { pending: [], accepted: [], refused: [] },
    accepted: 0,
    remaining: 1,
    expiresAt: undefined,
    createdAt: new Date('2026-11-10T12:00:00Z'),
    updatedAt: new Date('2026-11-10T12:00:00Z'),
    inviterId: INVITER_ID,
    inviterName: 'Ada Owner',
    ...over,
  }) as ISharerInviteView;

describe('buildPendingInviteRows', () => {
  it('gives each pending recipient exactly one row, with the sent date, inviter and role', () => {
    const rows = buildPendingInviteRows([
      invite({
        recipients: { pending: ['typed@example.com', USER_ID], accepted: [], refused: [] },
        recipientUsers: [{ userId: USER_ID, name: 'Grace Member' }],
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      label: 'typed@example.com',
      target: { email: 'typed@example.com' },
      role: 'viewer',
      inviterId: INVITER_ID,
      inviterName: 'Ada Owner',
    });
    expect(rows[0].sentAt?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(rows[1]).toMatchObject({ label: 'Grace Member', target: { userId: USER_ID } });
  });

  it('offers no target for a masked address', () => {
    const [row] = buildPendingInviteRows([
      invite({ recipients: { pending: ['a***@example.com'], accepted: [], refused: [] } }),
    ]);
    expect(row).toMatchObject({ label: 'a***@example.com', target: null });
  });

  it('acts on an unnamed id by id', () => {
    const [row] = buildPendingInviteRows([invite({ recipients: { pending: [USER_ID], accepted: [], refused: [] } })]);
    expect(row).toMatchObject({ label: 'Unknown user', target: { userId: USER_ID } });
  });

  it('skips link invites, which name nobody', () => {
    expect(
      buildPendingInviteRows([
        invite({ isLinkOnly: true, recipients: { pending: ['stray@example.com'], accepted: [], refused: [] } }),
      ])
    ).toEqual([]);
  });

  it('sorts newest first and tolerates a legacy invite with no inviter or date', () => {
    const rows = buildPendingInviteRows([
      invite({
        id: 'old',
        createdAt: undefined as unknown as Date,
        inviterId: undefined,
        inviterName: undefined,
        recipients: { pending: ['old@example.com'], accepted: [], refused: [] },
      }),
      invite({ id: 'new', recipients: { pending: ['new@example.com'], accepted: [], refused: [] } }),
    ]);
    expect(rows.map(row => row.label)).toEqual(['new@example.com', 'old@example.com']);
    expect(rows[1]).toMatchObject({ sentAt: null, inviterId: null, inviterName: null });
  });

  it('reads an admin invite as admin', () => {
    const [row] = buildPendingInviteRows([
      invite({
        permissions: [Permission.read, Permission.update, Permission.share],
        recipients: { pending: ['boss@example.com'], accepted: [], refused: [] },
      }),
    ]);
    expect(row.role).toBe('admin');
  });
});
