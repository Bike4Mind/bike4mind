import { describe, it, expect } from 'vitest';

import { validateBucketSpecs, validateSpecificOwnerFieldsPopulated } from './validateBucketSpecs';
import { BUCKET_SPECS } from './bucketSpecs';
import type { BucketSpecs, IdentityLookup, PullRequest } from './types';

const VALID_LOOKUP: IdentityLookup = {
  reviewer_: 'S0REVIEWERS',
  devops_: 'S0DEVOPS11',
};

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'x',
    url: 'https://example.test/1',
    isDraft: false,
    authorLogin: 'author',
    assigneeLogins: [],
    labels: [],
    requestedReviewerLogins: [],
    ...overrides,
  };
}

describe('validateBucketSpecs', () => {
  it('accepts the shipped lumina5 specs against a complete identity map', () => {
    expect(validateBucketSpecs(BUCKET_SPECS, VALID_LOOKUP)).toEqual([]);
  });

  it('rejects a roleKey with no entry in the identity map', () => {
    // The whole mitigation for a typo'd role prefix: it would otherwise render as NO
    // mention rather than an error, so the pool is silently never told anything.
    const errors = validateBucketSpecs(BUCKET_SPECS, { devops_: 'S0DEVOPS11' });

    expect(errors.some(error => error.bucket === 'awaitingReview' && error.reason.includes('reviewer_'))).toBe(true);
  });

  it('rejects a roleRoster spec that omits specificOwner rather than defaulting it', () => {
    const specs: BucketSpecs = {
      ...BUCKET_SPECS,
      awaitingReview: { ...BUCKET_SPECS.awaitingReview, specificOwner: undefined },
    };

    const errors = validateBucketSpecs(specs, VALID_LOOKUP);

    expect(errors.some(error => error.bucket === 'awaitingReview' && error.reason.includes('specificOwner'))).toBe(
      true
    );
  });

  it('rejects a roleRoster spec with no roleKey', () => {
    const specs: BucketSpecs = {
      ...BUCKET_SPECS,
      awaitingReview: { ...BUCKET_SPECS.awaitingReview, roleKey: undefined },
    };

    const errors = validateBucketSpecs(specs, VALID_LOOKUP);

    expect(errors.some(error => error.bucket === 'awaitingReview' && error.reason.includes('roleKey'))).toBe(true);
  });

  it('ignores specificOwner and roleKey on owner-mention buckets', () => {
    // They are unused there, so their absence is not an error.
    expect(BUCKET_SPECS.qaInProgress.mention).toBe('owner');
    expect(BUCKET_SPECS.qaInProgress.specificOwner).toBeUndefined();
    expect(validateBucketSpecs(BUCKET_SPECS, VALID_LOOKUP)).toEqual([]);
  });

  it('requires a catch-all so classification stays total', () => {
    const specs = { ...BUCKET_SPECS, none: { ...BUCKET_SPECS.none, role: 'standalone' as const } };

    const errors = validateBucketSpecs(specs, VALID_LOOKUP);

    expect(errors.some(error => error.reason.includes('catchAll'))).toBe(true);
  });

  it('rejects duplicate orders, which would make precedence ambiguous', () => {
    const specs: BucketSpecs = {
      ...BUCKET_SPECS,
      awaitingReview: { ...BUCKET_SPECS.awaitingReview, order: BUCKET_SPECS.reviewOngoing.order },
    };

    const errors = validateBucketSpecs(specs, VALID_LOOKUP);

    expect(errors.some(error => error.reason.includes('already used by'))).toBe(true);
  });
});

describe('validateSpecificOwnerFieldsPopulated', () => {
  it('rejects a gate field the provider never populates', () => {
    const errors = validateSpecificOwnerFieldsPopulated(BUCKET_SPECS, [pr({ requestedReviewerLogins: undefined })]);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].reason).toContain('requestedReviewerLogins');
  });

  it('accepts an empty array - absent is not empty', () => {
    expect(validateSpecificOwnerFieldsPopulated(BUCKET_SPECS, [pr({ requestedReviewerLogins: [] })])).toEqual([]);
  });

  it('accepts a mix, since a PR with nobody requested is ordinary', () => {
    const errors = validateSpecificOwnerFieldsPopulated(BUCKET_SPECS, [
      pr({ number: 1, requestedReviewerLogins: [] }),
      pr({ number: 2, requestedReviewerLogins: ['wescarda'] }),
    ]);

    expect(errors).toEqual([]);
  });

  it('says nothing about an empty PR list', () => {
    expect(validateSpecificOwnerFieldsPopulated(BUCKET_SPECS, [])).toEqual([]);
  });
});
