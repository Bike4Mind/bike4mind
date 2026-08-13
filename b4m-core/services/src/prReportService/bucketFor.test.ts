import { describe, it, expect } from 'vitest';

import { bucketFor, priorityTierFor } from './bucketFor';
import { BUCKET_SPECS } from './bucketSpecs';
import type { Bucket, PullRequest } from './types';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Some change',
    url: 'https://github.com/Bike4Mind/bike4mind/pull/1',
    isDraft: false,
    authorLogin: 'author',
    assigneeLogins: [],
    labels: [],
    requestedReviewerLogins: [],
    ...overrides,
  };
}

describe('bucketFor - totality', () => {
  it('assigns every PR to exactly one known bucket', () => {
    const known = new Set(Object.keys(BUCKET_SPECS));
    const samples = [
      pr(),
      pr({ labels: ['awaiting review'] }),
      pr({ isDraft: true }),
      pr({ labels: ['totally unrecognized label'] }),
      pr({ title: '', labels: [] }),
    ];

    for (const sample of samples) {
      expect(known.has(bucketFor(sample))).toBe(true);
    }
  });

  it('lands an unlabelled, unrecognized PR in the catch-all rather than nowhere', () => {
    expect(bucketFor(pr({ labels: ['preview-deployed'] }))).toBe('none');
    expect(BUCKET_SPECS.none.role).toBe('catchAll');
  });

  it('keeps the catch-all last in precedence, so nothing is absorbed early', () => {
    const orders = (Object.keys(BUCKET_SPECS) as Bucket[]).map(bucket => BUCKET_SPECS[bucket].order);
    expect(BUCKET_SPECS.none.order).toBe(Math.max(...orders));
  });
});

describe('bucketFor - precedence tie-breaks', () => {
  it('short-circuits a draft over any label', () => {
    expect(bucketFor(pr({ isDraft: true, labels: ['awaiting review', 'P0'] }))).toBe('draft');
  });

  it('short-circuits a release PR ahead of the draft check', () => {
    expect(bucketFor(pr({ isDraft: true, labels: ['autorelease: tagged'] }))).toBe('release');
  });

  it('does NOT let approval override a testing state', () => {
    // Review approval is not QA sign-off - an approved PR still in QA stays in QA.
    expect(bucketFor(pr({ labels: ['qa: in_progress'], isApproved: true }))).toBe('qaInProgress');
    expect(bucketFor(pr({ labels: ['awaiting testing'], isApproved: true }))).toBe('awaitingTesting');
  });

  it('checks testing before the review gates', () => {
    // Real shape from PR #1737: qa: in_progress + review_ongoing.
    expect(bucketFor(pr({ labels: ['qa: in_progress', 'review_ongoing'] }))).toBe('qaInProgress');
  });

  it('re-routes an approved review-gate PR to approvedAwaitingAuthor', () => {
    for (const label of ['awaiting review', 'review_ongoing', 'change request', 'devops', 'qa_passed']) {
      expect(bucketFor(pr({ labels: [label], isApproved: true }))).toBe('approvedAwaitingAuthor');
    }
  });

  it('does NOT re-route a standalone state on approval', () => {
    // The author already has agreed work to do, so approval does not change whose move
    // it is. This is the contrast with `change request`, which IS a stale gate.
    expect(bucketFor(pr({ labels: ['awaiting fix'], isApproved: true }))).toBe('awaitingFix');
    expect(bucketFor(pr({ labels: ['qa_failed'], isApproved: true }))).toBe('qaFailed');
    expect(bucketFor(pr({ labels: ['backlog'], isApproved: true }))).toBe('onHold');
  });

  it('treats unknown approval as not-approved rather than inventing a re-route', () => {
    // `undefined` means the approval source was unavailable. Routing on it would
    // assert something the data does not support.
    expect(bucketFor(pr({ labels: ['awaiting review'], isApproved: undefined }))).toBe('awaitingReview');
    expect(bucketFor(pr({ labels: ['awaiting review'], isApproved: false }))).toBe('awaitingReview');
  });

  it('prefers a specific state over the generic approved bucket', () => {
    expect(bucketFor(pr({ labels: ['done reviewing', 'change request'] }))).toBe('changeRequest');
    expect(bucketFor(pr({ labels: ['done reviewing'] }))).toBe('approved');
  });

  it('keeps a labelled PR in its labelled bucket over a title fallback', () => {
    expect(bucketFor(pr({ title: 'chore(deps): bump axios', labels: ['awaiting review'] }))).toBe('awaitingReview');
    expect(bucketFor(pr({ title: '[WIP] refactor', labels: ['awaiting review'] }))).toBe('awaitingReview');
  });

  it('still categorizes an unlabelled dependency bump or WIP via the title', () => {
    expect(bucketFor(pr({ title: 'chore(deps): bump axios' }))).toBe('dependencies');
    expect(bucketFor(pr({ title: 'bump lodash to 4.17.21' }))).toBe('dependencies');
    expect(bucketFor(pr({ title: '[WIP] new lattice' }))).toBe('inProgress');
  });

  it('ranks a merge conflict ahead of ready-to-merge', () => {
    // Real shape from PR #1726 / #1528: a conflicted qa_passed PR is blocked on the
    // author, not queued to merge.
    expect(bucketFor(pr({ labels: ['qa_passed', 'merge conflict'] }))).toBe('mergeConflict');
    expect(bucketFor(pr({ labels: ['qa_passed', 'merge queue issue'] }))).toBe('mergeConflict');
    expect(bucketFor(pr({ labels: ['qa_passed'] }))).toBe('readyForMerge');
  });

  it('matches labels case-insensitively and ignores surrounding whitespace', () => {
    expect(bucketFor(pr({ labels: ['  AWAITING Review  '] }))).toBe('awaitingReview');
    expect(bucketFor(pr({ labels: ['READY 2 SHIP'] }))).toBe('readyForMerge');
  });

  it('is deterministic across repeated calls', () => {
    const sample = pr({ labels: ['awaiting review', 'qa_passed', 'P1'] });
    const first = bucketFor(sample);
    expect(bucketFor(sample)).toBe(first);
    expect(bucketFor(sample)).toBe(first);
  });
});

describe('bucketFor - real open-PR shapes from Bike4Mind/bike4mind', () => {
  const cases: Array<{ number: number; labels: string[]; expected: Bucket }> = [
    { number: 1742, labels: ['qa_passed', 'review_ongoing'], expected: 'reviewOngoing' },
    { number: 1738, labels: ['awaiting review', 'qa_passed'], expected: 'awaitingReview' },
    { number: 1737, labels: ['qa: in_progress', 'review_ongoing'], expected: 'qaInProgress' },
    { number: 1736, labels: ['qa_passed', 'change request'], expected: 'changeRequest' },
    { number: 1726, labels: ['qa_passed', 'preview-deployed', 'merge conflict'], expected: 'mergeConflict' },
    { number: 1701, labels: ['awaiting review', 'qa_passed', 'preview-deployed'], expected: 'awaitingReview' },
    {
      number: 1641,
      labels: ['awaiting review', 'qa_passed', 'bot-review', 'preview-deployed'],
      expected: 'awaitingReview',
    },
    { number: 1528, labels: ['qa_passed', 'preview-deployed', 'merge queue issue'], expected: 'mergeConflict' },
  ];

  it.each(cases)('PR #$number → $expected', ({ number, labels, expected }) => {
    expect(bucketFor(pr({ number, labels }))).toBe(expected);
  });
});

describe('priorityTierFor', () => {
  it('reads the priority label, most urgent first', () => {
    expect(priorityTierFor(pr({ labels: ['P1'] }))).toBe('P1');
    expect(priorityTierFor(pr({ labels: ['P2', 'P0'] }))).toBe('P0');
    expect(priorityTierFor(pr({ labels: ['p3'] }))).toBe('P3');
  });

  it('returns null when no priority label is present', () => {
    expect(priorityTierFor(pr({ labels: ['awaiting review'] }))).toBeNull();
  });
});
