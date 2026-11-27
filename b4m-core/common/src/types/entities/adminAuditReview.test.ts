import { describe, expect, it } from 'vitest';
import { auditReviewConflict } from './adminAuditReview';

type Entry = Parameters<typeof auditReviewConflict>[0];

const entry = (actorUserId: string | null | undefined, target: Entry['target']): Entry => ({
  actor: { kind: 'user', userId: actorUserId ?? undefined, name: 'Actor' } as Entry['actor'],
  target,
});

describe('auditReviewConflict', () => {
  it('returns own_action when the user performed the entry', () => {
    expect(auditReviewConflict(entry('u1', { kind: 'organization', id: 'org' } as Entry['target']), 'u1')).toBe(
      'own_action'
    );
  });

  it('returns about_you when the target is the user account', () => {
    expect(auditReviewConflict(entry('other', { kind: 'user', id: 'u1' } as Entry['target']), 'u1')).toBe('about_you');
  });

  it('compares ids case-insensitively', () => {
    expect(auditReviewConflict(entry('ABCDEF', { kind: 'user', id: 'x' } as Entry['target']), 'abcdef')).toBe(
      'own_action'
    );
    expect(auditReviewConflict(entry('other', { kind: 'user', id: 'ABCDEF' } as Entry['target']), 'abcdef')).toBe(
      'about_you'
    );
  });

  it('prefers own_action when both apply', () => {
    expect(auditReviewConflict(entry('u1', { kind: 'user', id: 'u1' } as Entry['target']), 'u1')).toBe('own_action');
  });

  it('returns null for a missing actor user id and an unrelated target', () => {
    expect(auditReviewConflict(entry(null, { kind: 'user', id: 'someone' } as Entry['target']), 'u1')).toBeNull();
  });

  it('returns null when a non-user target shares the id', () => {
    expect(auditReviewConflict(entry('other', { kind: 'organization', id: 'u1' } as Entry['target']), 'u1')).toBeNull();
  });
});
