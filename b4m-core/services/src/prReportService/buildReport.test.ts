import { describe, it, expect } from 'vitest';

import { buildReport } from './buildReport';
import { BUCKET_SPECS } from './bucketSpecs';
import type { BucketSpecs, GenerateReportWarnings, IdentityLookup, PullRequest } from './types';

const NOW = new Date('2026-08-13T12:00:00Z');

const CLEAN: GenerateReportWarnings = {
  approvalDataUnavailable: false,
  openPrListTruncated: false,
};

const LOOKUP: IdentityLookup = {
  author: 'U0AUTHOR1',
  wescarda: 'U0WESCARD',
  qaperson: 'U0QAPERS1',
  reviewer_: 'S0REVIEWERS',
  devops_: 'S0DEVOPS11',
  qa_: 'S0QAPOOL11',
};

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 100,
    title: 'Some change',
    url: 'https://github.com/Bike4Mind/bike4mind/pull/100',
    isDraft: false,
    authorLogin: 'author',
    assigneeLogins: [],
    labels: [],
    requestedReviewerLogins: [],
    ...overrides,
  };
}

function render(prs: PullRequest[], warnings = CLEAN, specs: BucketSpecs = BUCKET_SPECS): string {
  return buildReport(prs, LOOKUP, specs, warnings, { now: NOW, timeZone: 'UTC' });
}

describe('buildReport - owner resolution', () => {
  it('prefers the first assignee over the author', () => {
    const text = render([pr({ labels: ['done reviewing'], authorLogin: 'author', assigneeLogins: ['wescarda'] })]);
    expect(text).toContain('<@U0WESCARD>');
    expect(text).not.toContain('<@U0AUTHOR1>');
  });

  it('falls back to the author when nobody is assigned', () => {
    const text = render([pr({ labels: ['done reviewing'], assigneeLogins: [] })]);
    expect(text).toContain('<@U0AUTHOR1>');
  });

  it('renders an unmapped login as plain escaped text, not a broken mention', () => {
    const text = render([pr({ labels: ['done reviewing'], authorLogin: 'ghost', assigneeLogins: [] })]);
    expect(text).toContain('ghost');
    expect(text).not.toContain('<@ghost>');
  });
});

describe('buildReport - role roster gating', () => {
  it('does NOT tag the pool when every PR in the section names a reviewer', () => {
    const text = render([
      pr({ number: 1, labels: ['awaiting review'], requestedReviewerLogins: ['wescarda'] }),
      pr({ number: 2, labels: ['awaiting review'], requestedReviewerLogins: ['wescarda'] }),
    ]);

    expect(text).not.toContain('<!subteam^S0REVIEWERS>');
    // The specifically-responsible person is still tagged, via the roster path.
    expect(text).toContain('<@U0WESCARD>');
  });

  it('DOES tag the pool when at least one PR names nobody', () => {
    const text = render([
      pr({ number: 1, labels: ['awaiting review'], requestedReviewerLogins: ['wescarda'] }),
      pr({ number: 2, labels: ['awaiting review'], requestedReviewerLogins: [] }),
    ]);

    // The subteam form is what actually notifies the group; a bare `<@S...>` renders as
    // inert text and would ping nobody - the exact failure this pins.
    expect(text).toContain('<!subteam^S0REVIEWERS>');
    expect(text).not.toContain('<@S0REVIEWERS>');
  });

  it('tags the devops pool independently of the general reviewer pool', () => {
    const text = render([pr({ labels: ['devops'], requestedReviewerLogins: [] })]);
    expect(text).toContain('<!subteam^S0DEVOPS11>');
    expect(text).not.toContain('<!subteam^S0REVIEWERS>');
  });

  it('omits the roster rather than rendering a broken mention when the roleKey is unmapped', () => {
    const text = buildReport(
      [pr({ labels: ['awaiting review'], requestedReviewerLogins: [] })],
      { author: 'U0AUTHOR1' },
      BUCKET_SPECS,
      CLEAN,
      { now: NOW, timeZone: 'UTC' }
    );

    expect(text).not.toContain('reviewer_');
    expect(text).not.toContain('<@undefined>');
  });

  // The renderer must stay correct for an assignee-gated roster even though lumina5's
  // own QA buckets use `mention: 'owner'` today (35 of 36 open PRs are self-assigned, so
  // an assignee gate here would be stuck shut). These two assertions are what a future
  // flip to `roleRoster` depends on, and the case a reviewer-only implementation gets
  // silently wrong on every single run.
  describe('assignee-gated roster (a QA section, once the assignment convention holds)', () => {
    const QA_ROSTER_SPECS: BucketSpecs = {
      ...BUCKET_SPECS,
      qaInProgress: {
        ...BUCKET_SPECS.qaInProgress,
        mention: 'roleRoster',
        roleKey: 'qa_',
        specificOwner: 'assignee',
      },
    };

    it('does not blanket-ping a fully-assigned QA section', () => {
      const text = render(
        [
          pr({ number: 1, labels: ['qa: in_progress'], assigneeLogins: ['qaperson'] }),
          pr({ number: 2, labels: ['qa: in_progress'], assigneeLogins: ['qaperson'] }),
        ],
        CLEAN,
        QA_ROSTER_SPECS
      );

      expect(text).not.toContain('<!subteam^S0QAPOOL11>');
      expect(text).toContain('<@U0QAPERS1>');
    });

    it('DOES open the gate when a QA PR has no assignee', () => {
      // The opening leg matters as much as the closing one: a gate wired to a field the
      // team never fills is stuck shut, and a stuck-shut gate passes the
      // does-not-blanket-ping assertion trivially while the pool is never told anything.
      const text = render(
        [
          pr({ number: 1, labels: ['qa: in_progress'], assigneeLogins: ['qaperson'] }),
          pr({ number: 2, labels: ['qa: in_progress'], assigneeLogins: [] }),
        ],
        CLEAN,
        QA_ROSTER_SPECS
      );

      expect(text).toContain('<!subteam^S0QAPOOL11>');
    });

    it('would be permanently open on the reviewer field - the bug this config avoids', () => {
      // A QA PR has no PENDING reviewer, precisely because review finished and QA began.
      // Left on 'requestedReviewer', the gate evaluates open on every run.
      const REVIEWER_GATED: BucketSpecs = {
        ...BUCKET_SPECS,
        qaInProgress: {
          ...BUCKET_SPECS.qaInProgress,
          mention: 'roleRoster',
          roleKey: 'qa_',
          specificOwner: 'requestedReviewer',
        },
      };

      const text = render(
        [pr({ labels: ['qa: in_progress'], assigneeLogins: ['qaperson'], requestedReviewerLogins: [] })],
        CLEAN,
        REVIEWER_GATED
      );

      expect(text).toContain('<!subteam^S0QAPOOL11>');
    });
  });
});

describe('buildReport - markup escaping', () => {
  it('escapes Slack-reserved characters in PR titles', () => {
    const text = render([pr({ title: 'fix <script> & <@U0EVIL999> injection', labels: ['done reviewing'] })]);

    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&amp;');
    // The crafted mention must not survive as a real one.
    expect(text).not.toContain('<@U0EVIL999>');
  });

  it('escapes an ampersand exactly once', () => {
    const text = render([pr({ title: 'a & b', labels: ['done reviewing'] })]);
    expect(text).toContain('a &amp; b');
    expect(text).not.toContain('&amp;amp;');
  });

  it('leaves underscores in identifiers alone so emphasis cannot be forged', () => {
    const text = render([pr({ title: 'handle qa_passed and qa_failed', labels: ['done reviewing'] })]);
    expect(text).toContain('qa_passed');
  });
});

describe('buildReport - sections and grouping', () => {
  it('omits empty sections', () => {
    const text = render([pr({ labels: ['done reviewing'] })]);
    expect(text).toContain('Approved');
    expect(text).not.toContain('Drafts');
    expect(text).not.toContain('Uncategorized');
  });

  it('orders sections by spec order', () => {
    const text = render([
      pr({ number: 1, labels: ['done reviewing'] }),
      pr({ number: 2, isDraft: true }),
      pr({ number: 3, labels: ['awaiting review'] }),
    ]);

    expect(text.indexOf('Drafts')).toBeLessThan(text.indexOf('Awaiting review'));
    expect(text.indexOf('Awaiting review')).toBeLessThan(text.indexOf('*Approved*'));
  });

  it('sub-groups by priority with the unlabelled tier last, labelled "standard"', () => {
    const text = render([
      pr({ number: 1, labels: ['awaiting review'] }),
      pr({ number: 2, labels: ['awaiting review', 'P0'] }),
      pr({ number: 3, labels: ['awaiting review', 'P2'] }),
    ]);

    expect(text.indexOf('_P0_')).toBeLessThan(text.indexOf('_P2_'));
    expect(text.indexOf('_P2_')).toBeLessThan(text.indexOf('_standard_'));
    // Deliberately not "none", which would collide with the catch-all bucket literal.
    expect(text).not.toContain('_none_');
  });

  it('sorts newest first inside a group', () => {
    const text = render([
      pr({ number: 10, labels: ['done reviewing'] }),
      pr({ number: 30, labels: ['done reviewing'] }),
      pr({ number: 20, labels: ['done reviewing'] }),
    ]);

    expect(text.indexOf('#30')).toBeLessThan(text.indexOf('#20'));
    expect(text.indexOf('#20')).toBeLessThan(text.indexOf('#10'));
  });
});

describe('buildReport - warnings are rendered into the text', () => {
  it('says approval data was unavailable', () => {
    const text = render([pr({ labels: ['awaiting review'] })], {
      approvalDataUnavailable: true,
      openPrListTruncated: false,
    });

    expect(text.toLowerCase()).toContain('approval data was unavailable');
  });

  it('says PRs were omitted and reports the count as a floor', () => {
    const text = render([pr({ labels: ['awaiting review'] })], {
      approvalDataUnavailable: false,
      openPrListTruncated: true,
    });

    expect(text).toContain('1+ open PRs');
    expect(text.toLowerCase()).toContain('omitted');
  });

  it('adds no advisory line to a clean report', () => {
    const text = render([pr({ labels: ['awaiting review'] })]);
    expect(text).not.toContain(':warning:');
    expect(text).toContain('1 open PR');
  });
});
