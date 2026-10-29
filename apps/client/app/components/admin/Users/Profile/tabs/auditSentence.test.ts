import { describe, expect, it } from 'vitest';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile } from '../profileTestUtils';
import { auditUndo, describeAuditEntry, formatAuditValue } from './auditSentence';

const profileUpdate = (changes: Array<{ field: string; before: unknown; after: unknown }>, id = 'e1') =>
  makeAuditEntry({ id, action: 'user.profile.updated', summary: 'updated fields', changes });

describe('describeAuditEntry', () => {
  it('words the common account changes', () => {
    expect(describeAuditEntry(profileUpdate([{ field: 'isBanned', before: false, after: true }]))).toBe(
      'Suspended account'
    );
    expect(describeAuditEntry(profileUpdate([{ field: 'isModerated', before: true, after: false }]))).toBe(
      'Lifted restriction'
    );
    expect(describeAuditEntry(profileUpdate([{ field: 'tags', before: ['a'], after: ['b'] }]))).toBe(
      'Tags: added b; removed a'
    );
  });

  it('shows a credit adjustment as the delta with before and after', () => {
    const entry = makeAuditEntry({
      action: 'user.credits.adjusted',
      changes: [{ field: 'currentCredits', before: 5410, after: 7410 }],
    });
    expect(describeAuditEntry(entry)).toBe('Credits +2,000 (5,410 to 7,410)');
  });

  it('uses a fixed sentence for known actions and flags denied ones', () => {
    expect(describeAuditEntry(makeAuditEntry({ action: 'user.mfa.reset' }))).toBe('Reset two-factor authentication');
    expect(describeAuditEntry(makeAuditEntry({ action: 'user.credits.denied', summary: 'over the cap' }))).toBe(
      'Blocked: over the cap'
    );
  });

  it('names the organization on membership entries', () => {
    const details = { organizationName: 'Acme' };
    expect(describeAuditEntry(makeAuditEntry({ action: 'org.member.added', details }))).toBe('Added to Acme');
    expect(describeAuditEntry(makeAuditEntry({ action: 'org.member.removed', details }))).toBe('Removed from Acme');
    expect(
      describeAuditEntry(
        makeAuditEntry({
          action: 'org.member.role_changed',
          details,
          changes: [{ field: 'role', before: 'member', after: 'manager' }],
        })
      )
    ).toBe('Made a manager of Acme');
  });

  it.each([
    ['member', [{ field: 'role', before: 'manager', after: 'member' }], 'Made a member of Acme'],
    ['an unrecognised role', [{ field: 'role', before: 'member', after: 'owner' }], 'Changed role in Acme'],
    ['a missing role change', undefined, 'Changed role in Acme'],
  ])('words a role change to %s', (_label, changes, expected) => {
    const entry = makeAuditEntry({
      action: 'org.member.role_changed',
      details: { organizationName: 'Acme' },
      changes,
    });
    expect(describeAuditEntry(entry)).toBe(expected);
  });

  it('falls back to the stored summary', () => {
    expect(describeAuditEntry(makeAuditEntry({ action: 'user.misc', summary: 'did a thing' }))).toBe('Did a thing');
  });
});

describe('formatAuditValue', () => {
  it('never renders an empty value as blank', () => {
    expect(formatAuditValue(null)).toBe('-');
    expect(formatAuditValue([])).toBe('None');
    expect(formatAuditValue(true)).toBe('Yes');
    expect(formatAuditValue(1234)).toBe('1,234');
  });
});

describe('auditUndo', () => {
  const suspend = profileUpdate([{ field: 'isBanned', before: false, after: true }]);

  it('reverses a field change that still stands', () => {
    expect(auditUndo(suspend, [], buildProfile({ isBanned: true }))).toEqual({
      patch: { isBanned: false },
      redo: { isBanned: true },
    });
  });

  it('refuses once the account no longer holds the written value', () => {
    expect(auditUndo(suspend, [], buildProfile({ isBanned: false }))).toBeNull();
  });

  it('refuses when a newer entry touched the same field', () => {
    const newer = profileUpdate([{ field: 'isBanned', before: true, after: true }], 'e2');
    expect(auditUndo(suspend, [newer], buildProfile({ isBanned: true }))).toBeNull();
  });

  it('refuses actions with their own flows, like credits and roles', () => {
    const credits = makeAuditEntry({
      action: 'user.credits.adjusted',
      changes: [{ field: 'currentCredits', before: 1, after: 2 }],
    });
    expect(auditUndo(credits, [], buildProfile({ currentCredits: 2 }))).toBeNull();
    const role = profileUpdate([{ field: 'isAdmin', before: false, after: true }]);
    expect(auditUndo(role, [], buildProfile({ isAdmin: true }))).toBeNull();
  });
});
