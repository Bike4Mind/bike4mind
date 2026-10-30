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
