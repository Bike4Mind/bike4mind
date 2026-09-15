import { describe, it, expect } from 'vitest';
import { flattenHeaders } from './flattenHeaders';

describe('flattenHeaders', () => {
  it('lowercases keys and takes the first value of an array', () => {
    expect(flattenHeaders({ Origin: 'https://x.com', 'X-Forwarded-For': ['1.1.1.1', '2.2.2.2'] })).toEqual({
      origin: 'https://x.com',
      'x-forwarded-for': '1.1.1.1',
    });
  });

  it('preserves undefined values', () => {
    expect(flattenHeaders({ authorization: undefined })).toEqual({ authorization: undefined });
  });
});
