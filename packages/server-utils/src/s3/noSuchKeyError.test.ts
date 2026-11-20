import { describe, expect, it } from 'vitest';
import { isNoSuchKeyError } from './noSuchKeyError';

describe('isNoSuchKeyError', () => {
  it('matches the SDK v3 NoSuchKey shape by name or Code', () => {
    expect(isNoSuchKeyError(Object.assign(new Error('gone'), { name: 'NoSuchKey' }))).toBe(true);
    expect(isNoSuchKeyError({ Code: 'NoSuchKey' })).toBe(true);
  });

  it('does not match a bare 404, NoSuchBucket or HeadObject NotFound', () => {
    expect(isNoSuchKeyError({ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isNoSuchKeyError({ $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isNoSuchKeyError({ name: 'NotFound' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isNoSuchKeyError(undefined)).toBe(false);
    expect(isNoSuchKeyError('NoSuchKey')).toBe(false);
  });
});
