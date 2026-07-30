import { describe, it, expect } from 'vitest';
import { CreateDataLakeRequestInput } from './dataLake';

const input = (fileTagPrefix: string) => ({ name: 'Lake', slug: 'my-lake', fileTagPrefix });

describe('CreateDataLakeRequestInput.fileTagPrefix', () => {
  it('accepts an ordinary namespaced prefix', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('acme:')).success).toBe(true);
  });

  it('requires a trailing colon', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('acme')).success).toBe(false);
  });

  // Without this, a lake's content prefix could match every other lake's membership meta-tag,
  // and removing a file from it would try to evict the file from all of them.
  it.each(['datalake:', 'datalake:x:'])('rejects the reserved namespace (%s)', prefix => {
    const result = CreateDataLakeRequestInput.safeParse(input(prefix));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => /reserved/i.test(i.message))).toBe(true);
    }
  });

  it('rejects the reserved namespace behind leading whitespace', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('  datalake:')).success).toBe(false);
  });
});
