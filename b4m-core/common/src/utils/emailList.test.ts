import { describe, expect, it } from 'vitest';
import { partitionEmailList } from './emailList';

describe('partitionEmailList', () => {
  it('keeps every valid address when one entry is invalid', () => {
    expect(partitionEmailList(['a@example.com', 'not-an-email', ' B@Example.com '])).toEqual({
      valid: ['a@example.com', 'b@example.com'],
      invalid: ['not-an-email'],
    });
  });

  it('dedupes addresses that differ only in case or whitespace', () => {
    expect(partitionEmailList(['a@example.com', ' A@EXAMPLE.COM']).valid).toEqual(['a@example.com']);
  });

  it('treats non-string entries as invalid and non-array input as empty', () => {
    expect(partitionEmailList(['a@example.com', 42, ''])).toEqual({ valid: ['a@example.com'], invalid: ['42', ''] });
    expect(partitionEmailList('a@example.com')).toEqual({ valid: [], invalid: [] });
  });
});
