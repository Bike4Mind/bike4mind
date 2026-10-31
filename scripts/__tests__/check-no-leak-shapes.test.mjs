import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The guard is exercised against throwaway git repositories, so every value below is
// synthetic: it exists only to have the SHAPE the guard looks for.
const script = fileURLToPath(new URL('../check-no-leak-shapes.sh', import.meta.url));
const ALLOWLIST = 'scripts/leak-shapes-allowlist.txt';
// Synthetic values are assembled at runtime so none of the shapes this guard looks for
// appears as a literal in this file, which the Restricted Terms check and GitHub push
// protection would otherwise reject.
const ARN_LINE = 'role: ' + ['arn', 'aws', 'iam', '', '2109' + '87654321', 'role/Deploy'].join(':') + '\n';
const PUBLIC_IP_LINE = '{ "ip": "51.20.33.44" }\n';
const WEBHOOK_LINE = ['https://hooks.slack.com/services', 'T0ABCDEFG', 'B0HIJKLMN', 'abcdefghij' + 'klmnopqrstuvwx'].join('/') + '\n';
let directory;

function write(file, source) {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function git(...args) {
  return execFileSync(
    'git',
    [
      '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
      // The developer's global excludes must not decide what the temp repo may stage.
      '-c', 'core.excludesFile=/dev/null',
      ...args,
    ],
    { cwd: directory, encoding: 'utf8' }
  );
}

function run(...args) {
  return spawnSync('bash', [script, ...args], { cwd: directory, encoding: 'utf8' });
}

function expectClean(result) {
  expect(result.stderr + result.stdout).not.toMatch(/failing closed|invalid regex/);
  expect(result.status).toBe(0);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'leak-shapes-'));
  git('init', '--quiet');
  write(ALLOWLIST, '# empty allowlist\n');
  write('README.md', '# hello\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('check-no-leak-shapes: paths', () => {
  it('passes a clean staged change', () => {
    write('docs/notes.md', 'A note with 10.0.0.1, 203.0.113.9, 1.2.3.4 and 123456789012.\n');
    git('add', 'docs/notes.md');
    expectClean(run('--staged'));
  });

  it.each([
    ['docs/superpowers/plans/x.md', 'local planning artifact'],
    ['.codex/session.json', 'local agent artifact'],
    ['index.html', 'root-level HTML page'],
    ['.restricted-terms.local', 'the local restricted-term file'],
  ])('blocks %s', (file, reason) => {
    write(file, 'harmless\n');
    git('add', '-f', file);
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${file}: ${reason}`);
  });

  it('allows a nested html file', () => {
    write('apps/web/public/index.html', '<html></html>\n');
    git('add', 'apps/web/public/index.html');
    expectClean(run('--staged'));
  });

  it('scans the new path of a renamed file', () => {
    write('plan.md', 'plan\n');
    git('add', 'plan.md');
    git('commit', '--quiet', '-m', 'plan');
    mkdirSync(join(directory, 'docs/superpowers'), { recursive: true });
    git('mv', 'plan.md', 'docs/superpowers/plan.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('docs/superpowers/plan.md: local planning artifact');
  });

  it('scans lines added to a renamed file under its new name', () => {
    write('a.md', 'one\n');
    git('add', 'a.md');
    git('commit', '--quiet', '-m', 'a');
    git('mv', 'a.md', 'b.md');
    write('b.md', `one\n${ARN_LINE}`);
    git('add', 'b.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('b.md:2: AWS ARN, 12-digit account id');
  });
});

describe('check-no-leak-shapes: added lines', () => {
  it('flags an ARN in a markdown file without echoing it', () => {
    write('runbook.md', `# Runbook\n${ARN_LINE}`);
    git('add', 'runbook.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('runbook.md:2: AWS ARN, 12-digit account id');
    expect(result.stdout).not.toContain('2109' + '87654321');
  });

  it('flags a public IPv4 address in a json file', () => {
    write('data/blocked.json', PUBLIC_IP_LINE);
    git('add', 'data/blocked.json');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('data/blocked.json:1: public IPv4 address');
  });

  it('flags a bare 12-digit id but not the placeholders', () => {
    write('deploy.yml', 'account: "2109' + '87654321"\nexample: 123456789012\nother: 111122223333\nzero: 000000000000\nuuid: 87654321-4321-4321-4321-876543210987\n');
    git('add', 'deploy.yml');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout.match(/deploy\.yml:\d+:/g)).toEqual(['deploy.yml:1:']);
  });

  it('flags a fully formed Slack webhook URL but not the host or a placeholder', () => {
    write('hooks.txt', `hosts: hooks.slack.com\nexample: https://hooks.slack.com/services/T00000000/B00000000/your-webhook-token\n${WEBHOOK_LINE}`);
    git('add', 'hooks.txt');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout.match(/hooks\.txt:\d+:/g)).toEqual(['hooks.txt:3:']);
  });

  it('reads the staged blob, not the worktree copy', () => {
    write('notes.md', 'clean\n');
    git('add', 'notes.md');
    write('notes.md', `clean\n${ARN_LINE}`);
    expectClean(run('--staged'));
  });

  it('ignores lines that already existed', () => {
    write('old.md', ARN_LINE);
    git('add', 'old.md');
    git('commit', '--quiet', '-m', 'old', '--no-verify');
    write('old.md', `${ARN_LINE}more text\n`);
    git('add', 'old.md');
    expectClean(run('--staged'));
  });

  it('fails closed on an invalid allowlist pattern', () => {
    write(ALLOWLIST, '[unclosed\n');
    write('x.md', 'x\n');
    git('add', 'x.md', ALLOWLIST);
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid regex');
  });
});

describe('check-no-leak-shapes: allowlist', () => {
  it('drops a content hit matched by path and keeps the rest', () => {
    write(ALLOWLIST, '# fixtures hold synthetic addresses\n^fixtures/\n');
    write('fixtures/ips.json', PUBLIC_IP_LINE);
    write('live.json', PUBLIC_IP_LINE);
    git('add', '.');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('live.json:1: public IPv4 address');
    expect(result.stdout).not.toContain('fixtures/ips.json');
  });

  it('drops a path hit', () => {
    write(ALLOWLIST, '^docs/superpowers/legacy\\.md$\n');
    write('docs/superpowers/legacy.md', 'kept\n');
    git('add', '.');
    expectClean(run('--staged'));
  });

  it('never drops a restricted-term hit', () => {
    write(ALLOWLIST, '^notes\\.md:\n');
    write('.restricted-terms.local', 'zorblax\n');
    write('notes.md', 'uses the zorblax client\n');
    git('add', 'notes.md', ALLOWLIST);
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('notes.md:1: restricted term');
  });
});

describe('check-no-leak-shapes: restricted terms', () => {
  it('matches a term on word boundaries, case-insensitively, without printing it', () => {
    write('.restricted-terms.local', '# comment\n\nzorblax\n');
    write('a.md', 'useZorblaxClient here\n');
    write('b.md', 'zorblaxification is fine\n');
    git('add', 'a.md', 'b.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('a.md:1: restricted term');
    expect(result.stdout).not.toContain('b.md');
    expect(result.stdout.toLowerCase()).not.toContain('zorblax');
  });

  it('withholds a path that matches a term', () => {
    write('.restricted-terms.local', 'zorblax\n');
    write('docs/zorblax-notes.md', 'plain\n');
    git('add', 'docs/zorblax-notes.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('<path withheld>: restricted term in path');
    expect(result.stdout).not.toContain('zorblax');
  });

  it('withholds a path that matches a term even when a path rule also fires', () => {
    write('.restricted-terms.local', 'zorblax\n');
    write('docs/superpowers/zorblax-plan.md', 'plain\n');
    git('add', 'docs/superpowers/zorblax-plan.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('<path withheld>: restricted term in path');
    expect(result.stdout).not.toContain('zorblax');
    expect(result.stdout).not.toContain('docs/superpowers');
  });

  it('folds the subject the way the CI checker does', () => {
    write('.restricted-terms.local', 'zorblax\n');
    // Fullwidth letters, a zero-width joiner and a combining accent over the same term.
    write('a.md', 'see \uFF5A\uFF4F\uFF52\uFF42\uFF4C\uFF41\uFF58 here\n');
    write('b.md', 'see zor\u200Dblax here\n');
    write('c.md', 'see zorbla\u0301x here\n');
    git('add', 'a.md', 'b.md', 'c.md');
    const result = run('--staged');
    expect(result.status).toBe(1);
    expect(result.stdout.match(/^[abc]\.md:1: restricted term$/gm)).toHaveLength(3);
  });

  it('tells the committer how to create the term file when it is absent', () => {
    write('x.md', 'x\n');
    git('add', 'x.md');
    const result = run('--staged');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('.restricted-terms.local');
    expect(result.stderr).toContain('private tracker');
  });
});

describe('check-no-leak-shapes: modes', () => {
  it('--changed <base> scans the commits since base and --all scans every tracked file', () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('infra/arn.md', ARN_LINE);
    git('add', 'infra/arn.md');
    git('commit', '--quiet', '-m', 'arn', '--no-verify');
    expect(run('--changed', base).stdout).toContain('infra/arn.md:1: AWS ARN');
    expect(run('--changed', 'HEAD').status).toBe(0);
    expect(run('--all').stdout).toContain('infra/arn.md:1: AWS ARN');
  });

  it('--changed with an unresolvable base falls back to --all', () => {
    write('infra/arn.md', ARN_LINE);
    git('add', 'infra/arn.md');
    git('commit', '--quiet', '-m', 'arn', '--no-verify');
    const result = run('--changed', 'no-such-ref');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unresolvable');
  });

  it('rejects an unknown option', () => {
    expect(run('--bogus').status).toBe(1);
  });
});
