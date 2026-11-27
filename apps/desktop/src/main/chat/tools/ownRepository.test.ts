import { afterEach, describe, expect, it, vi } from 'vitest';
import { ghReadFiles, repositoryWrite, writesOwnRepository, type GitReader } from './ownRepository';

const cwd = '/work/proj';
const words = (command: string) => command.split(' ');

describe('repositoryWrite', () => {
  it.each([
    ['git push', { kind: 'push', cwd, destinations: [], force: false }],
    ['git push -u origin feat/x', { kind: 'push', cwd, remote: 'origin', destinations: ['feat/x'], force: false }],
    ['git push origin HEAD', { kind: 'push', cwd, remote: 'origin', destinations: [''], force: false }],
    [
      'git push origin HEAD:heads/main',
      { kind: 'push', cwd, remote: 'origin', destinations: ['heads/main'], force: false },
    ],
    [
      'git push --force-with-lease origin HEAD:refs/heads/feat/x',
      { kind: 'push', cwd, remote: 'origin', destinations: ['feat/x'], force: true },
    ],
    ['git push -fu origin feat/x', { kind: 'push', cwd, remote: 'origin', destinations: ['feat/x'], force: true }],
    ['git push origin +feat/x', { kind: 'push', cwd, remote: 'origin', destinations: ['feat/x'], force: true }],
  ])('reads %s', (command, expected) => {
    expect(repositoryWrite(words(command), cwd)).toEqual(expected);
  });

  it.each([
    'git push https://example.com/evil/repo.git main',
    'git push git@example.com:evil/repo.git',
    'git push ../elsewhere main',
    'git push origin :main',
    'git push --delete origin feat/x',
    'git push --mirror origin',
    'git push --all origin',
    'git push --repo=evil origin',
    'git push --receive-pack=evil origin',
    'git -C /elsewhere push',
    'git -c remote.origin.url=evil push',
    'git fetch origin',
  ])('cannot pin %s to a configured remote', command => {
    expect(repositoryWrite(words(command), cwd)).toBeNull();
  });

  it.each([
    ['gh pr create --title x --body y', { kind: 'github', cwd }],
    ['gh issue comment 12 --body y', { kind: 'github', cwd }],
    ['gh pr create -R acme/app --title x', { kind: 'github', cwd, repository: { owner: 'acme', name: 'app' } }],
    [
      'gh pr comment https://github.com/acme/app/pull/3 --body y',
      { kind: 'github', cwd, repository: { owner: 'acme', name: 'app' } },
    ],
    [
      'gh api -X PATCH repos/acme/app/pulls/3 -f body=x',
      { kind: 'github', cwd, repository: { owner: 'acme', name: 'app' } },
    ],
    ['gh api repos/{owner}/{repo}/issues/3/comments -f body=x', { kind: 'github', cwd }],
    [
      'gh api -iq .x repos/victim/repo/issues -f title=t',
      { kind: 'github', cwd, repository: { owner: 'victim', name: 'repo' } },
    ],
  ])('reads %s', (command, expected) => {
    expect(repositoryWrite(words(command), cwd)).toEqual(expected);
  });

  it.each([
    'gh pr create -R ghe.example.com/acme/app',
    'gh pr create --hostname ghe.example.com',
    'gh pr comment https://github.com/other/app/pull/3 -R acme/app',
    'gh pr comment https://example.com/acme/app/pull/3',
    'gh api -X POST /gists -f description=x',
    'gh api graphql -f query=mutation{}',
    'gh api -X POST repos/{owner}/x/issues',
    'gh gist create notes.md',
    'gh pr create -Rvictim/repo --title t',
    'gh pr create -R=victim/repo --title t',
    'gh pr comment 3 -Fnotes.md',
    'gh api -X DELETE repos/acme/app/git/refs/heads/main',
    'gh api -X PUT repos/acme/app/pulls/7/merge',
    'gh api -X DELETE repos/acme/app',
    'gh api -X DELETE repos/acme/app/branches/main/protection',
    'gh api -X PATCH repos/acme/app -f default_branch=feature',
    'gh api -XDELETE repos/acme/app/issues/3',
    'gh api --method=PUT repos/acme/app/pulls/7/merge',
    'gh api -iFbody=@x repos/acme/app/issues',
    'gh api -Fbody=@/etc/x repos/acme/app/issues',
  ])('cannot pin %s to one repository', command => {
    expect(repositoryWrite(words(command), cwd)).toBeNull();
  });
});

describe('ghReadFiles', () => {
  it('names the files a gh call sends', () => {
    expect(ghReadFiles(words('gh pr create --body-file /tmp/body.md'))).toEqual(['/tmp/body.md']);
    expect(ghReadFiles(words('gh issue comment 3 -F notes.md'))).toEqual(['notes.md']);
    expect(ghReadFiles(words('gh api repos/a/b/issues --input data.json -F body=@~/x -f title=@y'))).toEqual([
      'data.json',
      '~/x',
    ]);
    expect(ghReadFiles(words('gh pr comment 3 -F -'))).toEqual([]);
  });
});

describe('writesOwnRepository', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A git that answers from a table keyed on the joined arguments; anything else fails. */
  const gitWith =
    (answers: Record<string, string>): GitReader =>
    async (_cwd, args) =>
      answers[args.join(' ')] ?? null;
  const origin = { 'config --get remote.origin.url': 'git@github.com:acme/app.git' };
  const pushRemotes = {
    'remote get-url --push origin': 'https://github.com/acme/app',
    'remote get-url --push fork': 'git@github.com:someone/app.git',
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/trunk',
  };
  const push = (command: string) => {
    const write = repositoryWrite(words(command), cwd);
    if (!write) throw new Error(`not a repository write: ${command}`);
    return write;
  };

  it('accepts a push to origin, named or through the branch upstream', async () => {
    const git = gitWith({
      ...origin,
      ...pushRemotes,
      'rev-parse --abbrev-ref --symbolic-full-name @{push}': 'origin/feat/x',
    });
    expect(await writesOwnRepository(push('git push'), git)).toBe(true);
    expect(await writesOwnRepository(push('git push -u origin feat/x'), git)).toBe(true);
    expect(await writesOwnRepository(push('git push origin trunk'), git)).toBe(true);
  });

  it('refuses a remote whose URL is another repository, and a folder with no origin', async () => {
    const git = gitWith({ ...origin, ...pushRemotes });
    expect(await writesOwnRepository(push('git push fork feat/x'), git)).toBe(false);
    expect(await writesOwnRepository(push('git push upstream feat/x'), git)).toBe(false);
    expect(await writesOwnRepository(push('git push origin feat/x'), gitWith(pushRemotes))).toBe(false);
  });

  it('refuses a force push that can reach the default branch, or names none', async () => {
    const git = gitWith({ ...origin, ...pushRemotes });
    expect(await writesOwnRepository(push('git push --force-with-lease origin feat/x'), git)).toBe(true);
    expect(await writesOwnRepository(push('git push -f origin HEAD:refs/heads/feat/x'), git)).toBe(true);
    for (const command of [
      'git push -f origin trunk',
      'git push origin +main',
      'git push -f origin master',
      'git push -f origin HEAD:heads/main',
      'git push -f origin HEAD:refs/tags/v1',
      'git push -f origin @',
      'git push -f origin HEAD',
      'git push origin +refs/heads/*:refs/heads/*',
      'git push -f origin',
      'git push -f',
    ]) {
      expect(await writesOwnRepository(push(command), git), command).toBe(false);
    }
  });

  it('refuses a force push when the remote default branch is unknown', async () => {
    const { 'symbolic-ref --short refs/remotes/origin/HEAD': _head, ...noHead } = pushRemotes;
    const git = gitWith({ ...origin, ...noHead });
    expect(await writesOwnRepository(push('git push -f origin feat/x'), git)).toBe(false);
    expect(await writesOwnRepository(push('git push origin feat/x'), git)).toBe(true);
  });

  it('refuses a push to a nested-group remote owned by someone else', async () => {
    const git = gitWith({
      'config --get remote.origin.url': 'git@gitlab.com:victim/sub/repo.git',
      'remote get-url --push fork': 'git@gitlab.com:attacker/sub/repo.git',
      'remote get-url --push origin': 'git@gitlab.com:victim/sub/repo.git',
    });
    expect(await writesOwnRepository(push('git push fork feat/x'), git)).toBe(false);
    expect(await writesOwnRepository(push('git push origin feat/x'), git)).toBe(true);
  });

  it('accepts gh writes aimed at origin on github.com', async () => {
    const git = gitWith({ ...origin, remote: 'origin' });
    expect(await writesOwnRepository(push('gh pr create --title x'), git)).toBe(true);
    expect(await writesOwnRepository(push('gh pr create -R ACME/app --title x'), git)).toBe(true);
    expect(await writesOwnRepository(push('gh api -X PATCH repos/acme/app/pulls/3 -f body=x'), git)).toBe(true);
    expect(await writesOwnRepository(push('gh api repos/acme/app/issues -f title=x'), git)).toBe(true);
  });

  it('refuses gh writes to another repository or host', async () => {
    const git = gitWith({ ...origin, remote: 'origin' });
    expect(await writesOwnRepository(push('gh pr create -R other/app --title x'), git)).toBe(false);
    expect(await writesOwnRepository(push('gh api -X POST repos/other/app/issues -f title=x'), git)).toBe(false);
    expect(
      await writesOwnRepository(push('gh api -iq repos/acme/app/x repos/victim/repo/issues -f title=t'), git)
    ).toBe(false);
    const gitlab = gitWith({ 'config --get remote.origin.url': 'git@gitlab.com:acme/app.git', remote: 'origin' });
    expect(await writesOwnRepository(push('gh pr create --title x'), gitlab)).toBe(false);
  });

  it("follows gh's choice of remote when the folder has several", async () => {
    const twoRemotes = { ...origin, ...pushRemotes, remote: 'origin\nfork' };
    expect(await writesOwnRepository(push('gh pr create'), gitWith(twoRemotes))).toBe(false);
    const markedOrigin = {
      ...twoRemotes,
      'config --get-regexp ^remote\\..*\\.gh-resolved$': 'remote.origin.gh-resolved base',
    };
    expect(await writesOwnRepository(push('gh pr create'), gitWith(markedOrigin))).toBe(true);
    const markedFork = {
      ...twoRemotes,
      'config --get-regexp ^remote\\..*\\.gh-resolved$': 'remote.fork.gh-resolved base',
    };
    expect(await writesOwnRepository(push('gh pr create'), gitWith(markedFork))).toBe(false);
  });

  it('refuses a default gh target when GH_REPO overrides it', async () => {
    vi.stubEnv('GH_REPO', 'other/app');
    expect(await writesOwnRepository(push('gh pr create'), gitWith({ ...origin, remote: 'origin' }))).toBe(false);
  });
});
