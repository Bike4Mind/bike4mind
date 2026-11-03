import { describe, expect, it } from 'vitest';
import { makeAuditEntry } from '@client/app/components/admin/AuditLog/shared/auditTestFixtures';
import { buildProfile } from '../profileTestUtils';
import { auditUndo, describeAuditEntry, fieldLabel, formatAuditValue } from './auditSentence';

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

  it('words an admin identity edit, naming the email the user still has to confirm', () => {
    const entry = makeAuditEntry({
      action: 'user.identity.updated',
      changes: [
        { field: 'name', before: 'Ada', after: 'Ada King' },
        { field: 'pendingEmail', before: null, after: 'new@example.com' },
      ],
    });
    expect(describeAuditEntry(entry)).toBe('Changed name; Requested an email change to new@example.com');
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

  it('words the other side of each toggle and falls back to the field name', () => {
    const sentence = (field: string, before: unknown, after: unknown) =>
      describeAuditEntry(profileUpdate([{ field, before, after }]));

    expect(sentence('isBanned', true, false)).toBe('Reinstated account');
    expect(sentence('isModerated', false, true)).toBe('Restricted account');
    expect(sentence('emailVerified', false, true)).toBe('Marked email verified');
    expect(sentence('emailVerified', true, false)).toBe('Marked email unverified');
    expect(sentence('tags', ['a'], ['a', 'b'])).toBe('Tags: added b');
    expect(sentence('tags', 'a', null)).toBe('Changed tags');
    expect(sentence('preferredContact', 'Text', 'Call')).toBe('Changed preferred contact');
  });

  it('shows a credit debit, a no-op and a change it cannot measure', () => {
    const credits = (before: unknown, after: unknown) =>
      describeAuditEntry(
        makeAuditEntry({ action: 'user.credits.adjusted', changes: [{ field: 'currentCredits', before, after }] })
      );

    expect(credits(500, 200)).toBe('Credits -300 (500 to 200)');
    expect(credits(5, 5)).toBe('Credits 0 (5 to 5)');
    expect(credits(null, 5)).toBe('Adjusted credits');
    expect(credits(5, '7')).toBe('Adjusted credits');
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
    expect(formatAuditValue(undefined)).toBe('-');
    expect(formatAuditValue('')).toBe('-');
    expect(formatAuditValue(false)).toBe('No');
    expect(formatAuditValue(['a', 2])).toBe('a, 2');
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
  });

  it('labels known fields and humanizes the rest', () => {
    expect(fieldLabel('isBanned')).toBe('Suspended');
    expect(fieldLabel('api_key.scope')).toBe('Api key scope');
  });
});

describe('auditUndo', () => {
  const suspend = { ...profileUpdate([{ field: 'isBanned', before: false, after: true }]), reason: 'Chargeback' };

  it('reverses a field change that still stands', () => {
    expect(auditUndo(suspend, [], buildProfile({ isBanned: true }))).toEqual({
      patch: { isBanned: false, statusChangeReason: 'Undo: Chargeback' },
      redo: { isBanned: true, statusChangeReason: 'Chargeback' },
    });
  });

  it('undoes a dedicated user.suspended entry, carrying the stored reason and marking the undo', () => {
    const entry = makeAuditEntry({
      action: 'user.suspended',
      summary: 'suspended the account',
      reason: 'Repeated abuse reports',
      changes: [{ field: 'isBanned', before: false, after: true }],
    });
    expect(auditUndo(entry, [], buildProfile({ isBanned: true }))).toEqual({
      patch: { isBanned: false, statusChangeReason: 'Undo: Repeated abuse reports' },
      redo: { isBanned: true, statusChangeReason: 'Repeated abuse reports' },
    });
  });

  it.each([
    ['user.reinstated', 'isBanned', true, false],
    ['user.restricted', 'isModerated', false, true],
    ['user.restriction_lifted', 'isModerated', true, false],
  ] as const)('accepts %s entries', (action, field, before, after) => {
    const entry = makeAuditEntry({ action, reason: 'Because it was needed', changes: [{ field, before, after }] });
    expect(auditUndo(entry, [], buildProfile({ [field]: after }))).toEqual({
      patch: { [field]: before, statusChangeReason: 'Undo: Because it was needed' },
      redo: { [field]: after, statusChangeReason: 'Because it was needed' },
    });
  });

  it.each([
    ['a legacy user.profile.updated', profileUpdate([{ field: 'isBanned', before: false, after: true }])],
    [
      'a user.suspended',
      makeAuditEntry({ action: 'user.suspended', changes: [{ field: 'isBanned', before: false, after: true }] }),
    ],
  ])('offers no undo for %s status entry without a stored reason', (_label, entry) => {
    expect(auditUndo(entry, [], buildProfile({ isBanned: true }))).toBeNull();
  });

  it('sends no statusChangeReason for a tags-only undo', () => {
    const tags = profileUpdate([{ field: 'tags', before: ['a'], after: ['b'] }]);
    const undo = auditUndo(tags, [], buildProfile({ tags: ['b'] }));
    expect(undo).toEqual({ patch: { tags: ['a'] }, redo: { tags: ['b'] } });
    expect(undo?.patch).not.toHaveProperty('statusChangeReason');
    expect(undo?.redo).not.toHaveProperty('statusChangeReason');
  });

  it('refuses once the account no longer holds the written value', () => {
    expect(auditUndo(suspend, [], buildProfile({ isBanned: false }))).toBeNull();
  });

  it('refuses when a newer entry touched the same field', () => {
    const newer = profileUpdate([{ field: 'isBanned', before: true, after: true }], 'e2');
    expect(auditUndo(suspend, [newer], buildProfile({ isBanned: true }))).toBeNull();
  });

  it('reverses restriction and tag changes, restoring a missing before to its default', () => {
    const restrict = { ...profileUpdate([{ field: 'isModerated', before: undefined, after: true }]), reason: 'Spam' };
    expect(auditUndo(restrict, [], buildProfile({ isModerated: true }))).toEqual({
      patch: { isModerated: false, statusChangeReason: 'Undo: Spam' },
      redo: { isModerated: true, statusChangeReason: 'Spam' },
    });
    const tag = profileUpdate([{ field: 'tags', before: null, after: ['vip'] }]);
    expect(auditUndo(tag, [], buildProfile({ tags: ['vip'] }))).toEqual({
      patch: { tags: [] },
      redo: { tags: ['vip'] },
    });
  });

  it('treats unset flags and tags on the account as false and empty', () => {
    const unban = { ...profileUpdate([{ field: 'isBanned', before: true, after: false }]), reason: 'Appeal upheld' };
    expect(auditUndo(unban, [], buildProfile({ isBanned: undefined }))).toEqual({
      patch: { isBanned: true, statusChangeReason: 'Undo: Appeal upheld' },
      redo: { isBanned: false, statusChangeReason: 'Appeal upheld' },
    });
    const lift = { ...profileUpdate([{ field: 'isModerated', before: true, after: false }]), reason: 'Appeal upheld' };
    expect(auditUndo(lift, [], buildProfile({ isModerated: undefined }))).not.toBeNull();
    const clear = profileUpdate([{ field: 'tags', before: ['a'], after: [] }]);
    expect(auditUndo(clear, [], buildProfile({ tags: undefined }))).not.toBeNull();
  });

  it('ignores newer entries that carry no changes or touch other fields', () => {
    const bare = makeAuditEntry({ id: 'e2', action: 'user.mfa.reset' });
    const other = profileUpdate([{ field: 'tags', before: [], after: ['a'] }], 'e3');
    expect(auditUndo(suspend, [bare, other], buildProfile({ isBanned: true }))).not.toBeNull();
  });

  it('refuses when the entry wrote no value the account could still hold', () => {
    const unknownAfter = profileUpdate([{ field: 'isBanned', before: false, after: undefined }]);
    expect(auditUndo(unknownAfter, [], buildProfile({ isBanned: true }))).toBeNull();
  });

  it('refuses a profile update with no changes recorded', () => {
    expect(auditUndo(makeAuditEntry({ action: 'user.profile.updated' }), [], buildProfile())).toBeNull();
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
