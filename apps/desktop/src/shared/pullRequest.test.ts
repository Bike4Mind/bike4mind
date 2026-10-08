import { describe, expect, it } from 'vitest';
import {
  ciSummary,
  findPullRequestUrls,
  parsePullRequestUrl,
  pullRequestFromShell,
  samePullRequest,
  type PrCheck,
} from './pullRequest';

const GH_PR_CREATE_OUTPUT = [
  'Warning: 2 uncommitted changes',
  '',
  'Creating pull request for feat/widget-ladder into main in example-org/widgets',
  '',
  'https://github.com/example-org/widgets/pull/611',
  '',
].join('\n');

const FIRST_PUSH_OUTPUT = [
  'remote:',
  "remote: Create a pull request for 'feat/widget-ladder' on GitHub by visiting:",
  'remote:      https://github.com/example-org/widgets/pull/new/feat/widget-ladder',
  'remote:',
  'To https://github.com/example-org/widgets.git',
  ' * [new branch]      feat/widget-ladder -> feat/widget-ladder',
].join('\n');

const LATER_PUSH_OUTPUT = [
  'remote:',
  'remote: View pull request for feat/widget-ladder:',
  'remote:      https://github.com/example-org/widgets/pull/611',
  'remote:',
  'To https://github.com/example-org/widgets.git',
  '   1a2b3c4..5d6e7f8  feat/widget-ladder -> feat/widget-ladder',
].join('\n');

describe('pullRequestFromShell', () => {
  it('reads the URL gh pr create prints', () => {
    expect(pullRequestFromShell('gh pr create --fill', GH_PR_CREATE_OUTPUT)).toEqual({
      owner: 'example-org',
      repo: 'widgets',
      number: 611,
      url: 'https://github.com/example-org/widgets/pull/611',
    });
  });

  it('reads a gh pr create that is part of a chain', () => {
    expect(pullRequestFromShell('git push -u origin HEAD && gh pr create --title x', GH_PR_CREATE_OUTPUT)?.number).toBe(
      611
    );
  });

  it('reads the existing PR a git push names', () => {
    expect(pullRequestFromShell('git push', LATER_PUSH_OUTPUT)?.number).toBe(611);
  });

  it('ignores the create-a-PR link a first push prints', () => {
    expect(pullRequestFromShell('git push -u origin feat/widget-ladder', FIRST_PUSH_OUTPUT)).toBeNull();
  });

  it('ignores PR URLs printed by commands that do not create or push one', () => {
    expect(pullRequestFromShell('gh pr list', GH_PR_CREATE_OUTPUT)).toBeNull();
    expect(pullRequestFromShell('cat CHANGELOG.md', 'see https://github.com/example-org/widgets/pull/12')).toBeNull();
    expect(pullRequestFromShell('echo gh pr created', GH_PR_CREATE_OUTPUT)).toBeNull();
  });

  it('takes the last URL when output mentions several', () => {
    const output =
      'related: https://github.com/example-org/widgets/pull/600\nhttps://github.com/example-org/widgets/pull/611\n';
    expect(pullRequestFromShell('gh pr create', output)?.number).toBe(611);
  });
});

describe('findPullRequestUrls', () => {
  it('finds URLs inside other text and stops at the number', () => {
    expect(findPullRequestUrls('(https://github.com/a-b/c.d/pull/7).').map(ref => ref.url)).toEqual([
      'https://github.com/a-b/c.d/pull/7',
    ]);
  });
});

describe('parsePullRequestUrl', () => {
  it('accepts a URL copied from the browser, tab and all', () => {
    expect(parsePullRequestUrl(' https://github.com/example-org/widgets/pull/42/checks?x=1 ')?.url).toBe(
      'https://github.com/example-org/widgets/pull/42'
    );
  });

  it('refuses anything that is not a GitHub PR', () => {
    expect(parsePullRequestUrl('https://github.com/example-org/widgets/issues/42')).toBeNull();
    expect(parsePullRequestUrl('https://example.com/example-org/widgets/pull/42')).toBeNull();
    expect(parsePullRequestUrl('https://github.com/example-org/widgets/pull/0')).toBeNull();
    expect(parsePullRequestUrl('javascript:alert(1)//github.com/a/b/pull/1')).toBeNull();
  });
});

describe('samePullRequest', () => {
  it('compares owner and repo without case', () => {
    expect(
      samePullRequest(
        { owner: 'Example-Org', repo: 'Widgets', number: 1, url: '' },
        { owner: 'example-org', repo: 'widgets', number: 1, url: '' }
      )
    ).toBe(true);
  });
});

describe('ciSummary', () => {
  const check = (bucket: PrCheck['bucket']): PrCheck => ({ name: bucket, bucket, required: false });

  it('lets a failure outrank anything still running', () => {
    expect(ciSummary([check('pass'), check('pending'), check('fail')])).toBe('fail');
    expect(ciSummary([check('pass'), check('pending')])).toBe('pending');
    expect(ciSummary([check('pass'), check('skipped')])).toBe('pass');
    expect(ciSummary([])).toBe('none');
  });
});
