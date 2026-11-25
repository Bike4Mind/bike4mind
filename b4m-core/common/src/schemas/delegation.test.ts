import { describe, it, expect } from 'vitest';
import { DELEGATION_LIMITS, DelegationCreateRequestSchema } from './delegation';

const valid = (body: Record<string, unknown>) => DelegationCreateRequestSchema.safeParse(body).success;

describe('DelegationCreateRequestSchema', () => {
  it('accepts an intent with a url, text and file ids', () => {
    expect(
      valid({ intent: 'Summarize for the team', url: 'https://example.com/a', text: 'notes', file_ids: ['f1'] })
    ).toBe(true);
  });

  it.each([
    ['an empty intent', ''],
    ['a blank intent', '   '],
    ['a multi-line intent', 'handle this\nplease'],
    ['an intent over the cap', 'x'.repeat(DELEGATION_LIMITS.intent + 1)],
  ])('rejects %s', (_label, intent) => {
    expect(valid({ intent, text: 'x' })).toBe(false);
  });

  it('rejects a non-http url', () => {
    expect(valid({ intent: 'read', url: 'file:///etc/passwd' })).toBe(false);
  });

  it('rejects too many files and a camelCase field', () => {
    const fileIds = Array.from({ length: DELEGATION_LIMITS.files + 1 }, (_, i) => `f${i}`);
    expect(valid({ intent: 'read', file_ids: fileIds })).toBe(false);
    expect(valid({ intent: 'read', fileIds: ['f1'] })).toBe(false);
  });
});
