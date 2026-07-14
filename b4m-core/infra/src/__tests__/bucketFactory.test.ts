import { describe, it, expect } from 'vitest';
import {
  retainedBucketName,
  bucketRetention,
  expireAfterDays,
  expireNoncurrentVersionsAfterDays,
} from '../bucketFactory.js';

describe('retainedBucketName', () => {
  it('builds the legacy physical name on production', () => {
    expect(retainedBucketName({ stage: 'production', appName: 'b4m', suffix: 'fabfilesbucket' })).toBe(
      'production-b4m-buckets-fabfilesbucket'
    );
  });

  it('builds the legacy physical name on dev', () => {
    expect(retainedBucketName({ stage: 'dev', appName: 'b4m', suffix: 'appfilesbucket' })).toBe(
      'dev-b4m-buckets-appfilesbucket'
    );
  });

  it('returns undefined on ephemeral stages', () => {
    expect(retainedBucketName({ stage: 'pr-123', appName: 'b4m', suffix: 'fabfilesbucket' })).toBeUndefined();
  });

  it('an explicit override always wins', () => {
    expect(
      retainedBucketName({ stage: 'pr-123', appName: 'b4m', suffix: 'fabfilesbucket', override: 'my-bucket' })
    ).toBe('my-bucket');
  });

  it('honors custom retained stages', () => {
    expect(
      retainedBucketName({ stage: 'staging', appName: 'b4m', suffix: 'x', retainedStages: ['staging'] })
    ).toBe('staging-b4m-buckets-x');
  });
});

describe('bucketRetention', () => {
  it('retains named buckets and destroys unnamed ones', () => {
    expect(bucketRetention('production-b4m-buckets-fabfilesbucket')).toEqual({ retainOnDelete: true });
    expect(bucketRetention(undefined)).toEqual({ retainOnDelete: false });
  });
});

describe('expireAfterDays', () => {
  it('builds a whole-bucket expiration rule with the 1-day upload cleanup default', () => {
    expect(expireAfterDays({ id: 'auto-delete-old-exports', days: 7 })).toEqual({
      id: 'auto-delete-old-exports',
      status: 'Enabled',
      expiration: { days: 7 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
    });
  });

  it('builds a prefix-scoped rule', () => {
    expect(expireAfterDays({ id: 'expire-drafts', days: 1, prefix: 'drafts/' })).toEqual({
      id: 'expire-drafts',
      status: 'Enabled',
      filter: { prefix: 'drafts/' },
      expiration: { days: 1 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
    });
  });

  it('rejects non-positive or fractional days', () => {
    expect(() => expireAfterDays({ id: 'bad', days: 0 })).toThrow('positive integer');
    expect(() => expireAfterDays({ id: 'bad', days: 1.5 })).toThrow('positive integer');
  });
});

describe('expireNoncurrentVersionsAfterDays', () => {
  it('builds a noncurrent-version expiration rule', () => {
    expect(expireNoncurrentVersionsAfterDays('expire-old-versions', 90)).toEqual({
      id: 'expire-old-versions',
      status: 'Enabled',
      noncurrentVersionExpiration: { noncurrentDays: 90 },
    });
  });

  it('rejects non-positive days', () => {
    expect(() => expireNoncurrentVersionsAfterDays('bad', -1)).toThrow('positive integer');
  });
});
