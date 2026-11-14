import { describe, expect, it } from 'vitest';
import { foreverRetention, retentionCutoff, retentionPolicySchema, shortensRetention } from './OrganizationRetention';

describe('organization retention policy', () => {
  it('defaults to forever without a deletion cutoff', () => {
    expect(Object.values(foreverRetention)).toEqual([null, null, null]);
    expect(retentionCutoff(null, new Date())).toBeNull();
  });
  it('requires confirmation for each newly finite or shortened category', () => {
    for (const kind of ['chats', 'files', 'media'] as const) {
      expect(shortensRetention(foreverRetention, { ...foreverRetention, [kind]: 30 })).toBe(true);
      expect(shortensRetention({ ...foreverRetention, [kind]: 60 }, { ...foreverRetention, [kind]: 30 })).toBe(true);
      expect(shortensRetention({ ...foreverRetention, [kind]: 30 }, foreverRetention)).toBe(false);
    }
  });
  it('uses exact UTC day boundaries', () => {
    expect(retentionCutoff(1, new Date('2026-10-12T12:00:00Z'))).toEqual(new Date('2026-10-11T12:00:00Z'));
  });
  it.each([0, -1, 1.5, 36501, '30', NaN])('rejects invalid days %s', value => {
    expect(retentionPolicySchema.safeParse({ ...foreverRetention, chats: value }).success).toBe(false);
  });
});
