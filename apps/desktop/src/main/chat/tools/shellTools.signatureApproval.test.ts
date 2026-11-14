import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shellApproval } from './shellTools';

/** Real Git reaches only a disposable marker program: no keys, network or real verifier. */
describe('configured signature verifier approval', () => {
  let root: string;
  let verifier: string;
  let marker: string;
  const git = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', root, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-verifier-gate-')));
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
    git(['init', '-q']);
    verifier = join(root, 'marker-verifier');
    marker = `${verifier}.marker`;
    writeFileSync(verifier, '#!/bin/sh\nprintf called >> "$0.marker"\ncat >/dev/null\nexit 1\n', { mode: 0o755 });
    git(['config', 'gpg.program', verifier]);
    const tree = git(['mktree'], '');
    const commit = git(
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      [
        `tree ${tree}`,
        'author Test <test@example.invalid> 1700000000 +0000',
        'committer Test <test@example.invalid> 1700000000 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' ',
        ' dGVzdA==',
        ' -----END PGP SIGNATURE-----',
        '',
        'Synthetic signed object for a harmless verifier control.',
        '',
      ].join('\n')
    );
    git(['update-ref', 'HEAD', commit]);
    git(['update-ref', '--create-reflog', '-m', 'fixture', 'refs/stash', commit]);
    const tag = git(
      ['hash-object', '-t', 'tag', '-w', '--stdin'],
      `object ${commit}\ntype commit\ntag fixture\ntagger Test <test@example.invalid> 1700000000 +0000\n\nfixture\n`
    );
    git(['update-ref', 'refs/tags/fixture', tag]);
    git(['config', 'pretty.SIG.foo', 'format:%G?']);
    git(['config', 'pretty.sig.foo', 'format:%h']);
  });

  afterEach(() => rmSync(marker, { force: true }));
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["git log --format='%G?'", ['log', '--format=%G?'], false],
    ["git log --format='%+G?'", ['log', '--format=%+G?'], false],
    ["git log --format='%-GS'", ['log', '--format=%-GS'], false],
    ["git log --format='% G?'", ['log', '--format=% G?'], false],
    ['git log --pretty=SIG.foo', ['log', '--pretty=SIG.foo'], false],
    [
      "git for-each-ref --format='%(*signature:grade)' refs/tags",
      ['for-each-ref', '--format=%(*signature:grade)', 'refs/tags'],
      false,
    ],
    ['git stash list', ['stash', 'list'], true],
  ] as const)('asks before %s can invoke the configured verifier', async (command, args, showsSignature) => {
    git(['config', 'log.showSignature', String(showsSignature)]);
    git([...args]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const prompt = await shellApproval(
      'bash_execute',
      { command, cwd: root },
      {
        roots: [root],
        workingDirectory: root,
        signal: new AbortController().signal,
      }
    );
    expect(prompt.askInAuto).toBe(true);
    expect(prompt.askInFull).toBe(true);
    expect(prompt.byPart).not.toBe(true);
    expect(prompt.allowOnce).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['%%G?', '%%%%G?', '%x25G?', '%h'])('does not mistake literal format %s for verification', async format => {
    git(['config', 'log.showSignature', 'false']);
    git(['log', `--format=${format}`]);
    expect(existsSync(marker)).toBe(false);
    const prompt = await shellApproval(
      'bash_execute',
      { command: `git log --format='${format}'`, cwd: root },
      {
        roots: [root],
        workingDirectory: root,
        signal: new AbortController().signal,
      }
    );
    expect(prompt.askInFull).not.toBe(true);
  });
});
