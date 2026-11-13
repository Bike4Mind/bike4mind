import { describe, expect, it } from 'vitest';
import { classifyOrgInviteRows, type OrgInviteRowContext } from './classifyOrgInviteRows';

const context = (overrides: Partial<OrgInviteRowContext> = {}): OrgInviteRowContext => ({
  memberEmails: new Set(['member@example.com']),
  ownerEmail: 'Owner@Example.com',
  pendingEmails: new Set(['pending@example.com']),
  availableSeats: 10,
  ...overrides,
});

const statuses = (rows: string[], overrides?: Partial<OrgInviteRowContext>) =>
  classifyOrgInviteRows(rows, context(overrides)).map(row => row.status);

describe('classifyOrgInviteRows', () => {
  it('classifies each row independently', () => {
    expect(
      statuses(['new@example.com', 'member@example.com', 'pending@example.com', 'not-an-email', 'owner@example.com'])
    ).toEqual(['invite', 'already_member', 'already_pending', 'invalid', 'already_member']);
  });

  it('marks empty and whitespace-only rows invalid', () => {
    expect(statuses(['', '   '])).toEqual(['invalid', 'invalid']);
  });

  it('trims and lowercases, and keeps only the first of a case-insensitive duplicate', () => {
    const rows = classifyOrgInviteRows(['  New@Example.com ', 'NEW@example.com'], context());
    expect(rows).toEqual([
      { email: 'new@example.com', raw: '  New@Example.com ', status: 'invite' },
      { email: 'new@example.com', raw: 'NEW@example.com', status: 'duplicate' },
    ]);
  });

  it('gives seats to new rows in input order and marks the rest seat_limit', () => {
    expect(
      statuses(['a@example.com', 'member@example.com', 'b@example.com', 'c@example.com'], { availableSeats: 2 })
    ).toEqual(['invite', 'already_member', 'invite', 'seat_limit']);
  });

  it.each([0, -3])('invites nobody when %i seats are available', availableSeats => {
    expect(statuses(['a@example.com', 'member@example.com'], { availableSeats })).toEqual([
      'seat_limit',
      'already_member',
    ]);
  });
});
