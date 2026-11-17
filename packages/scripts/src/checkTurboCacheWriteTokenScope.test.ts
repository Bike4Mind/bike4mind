import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on where the Turborepo remote cache write token may be used.
 *
 * Anyone holding the write token can publish artifacts that later builds restore, and this cache
 * has no read-side signature check, so the token's reach is the whole integrity boundary
 * (docs/architecture/turbo-remote-cache.md, "Trust model"). Pull-request, merge-queue and
 * manually dispatched runs execute code that has not been merged, so a workflow that references
 * the write token must be triggered by `push` alone and its job must run in a GitHub Environment,
 * which is where the restriction to `main` lives.
 *
 * Text-matched rather than YAML-parsed, like the sibling workflow guards: the repo has no YAML
 * parser dependency. The check is per workflow file, which is stricter than per job.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/** The write token's documented secret names. The read token (TURBO_CACHE_READ_TOKEN) is not matched. */
const WRITE_TOKEN_REF = /secrets\.(TURBO_TOKEN|TURBO_CACHE_TOKEN)\b/;

/** Top-level trigger names from the `on:` key, in its inline, list and block forms. */
function workflowTriggers(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex(line => /^(on|'on'|"on"):/.test(line));
  if (start === -1) return [];
  const inline = lines[start]
    .replace(/^(on|'on'|"on"):/, '')
    .replace(/#.*$/, '')
    .trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean);
  }
  const triggers: string[] = [];
  let indent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s+)(?:-\s*)?([A-Za-z_]+)\s*:?\s*(?:#.*)?$/);
    if (!match) continue;
    indent ??= match[1].length;
    if (match[1].length === indent) triggers.push(match[2]);
  }
  return triggers;
}

/** Problems with a workflow's use of the write token; empty when it does not use it or uses it safely. */
function writeTokenProblems(contents: string): string[] {
  if (!WRITE_TOKEN_REF.test(contents)) return [];
  const problems: string[] = [];
  const untrusted = workflowTriggers(contents).filter(trigger => trigger !== 'push');
  if (untrusted.length > 0) problems.push(`triggered by ${untrusted.join(', ')}, not push alone`);
  if (!/^\s+environment:/m.test(contents)) problems.push('no job runs in a GitHub Environment');
  return problems;
}

describe('Turborepo cache write token scope', () => {
  it('allows the write token in a push-only workflow whose job runs in an environment', () => {
    const workflow = [
      'on:',
      '  push:',
      '    branches: [main]',
      'jobs:',
      '  build:',
      '    environment: turbo-cache',
      '    env:',
      '      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}',
    ].join('\n');
    expect(writeTokenProblems(workflow)).toEqual([]);
  });

  it.each([
    ['pull_request', 'on:\n  pull_request:\n  push:\n    branches: [main]\n'],
    ['merge_group', 'on:\n  merge_group:\n  push:\n'],
    ['workflow_dispatch', 'on: [push, workflow_dispatch]\n'],
    ['pull_request_target', "'on':\n  - push\n  - pull_request_target\n"],
  ])('rejects the write token in a workflow also triggered by %s', (trigger, on) => {
    const workflow = `${on}jobs:\n  build:\n    environment: turbo-cache\n    env:\n      TURBO_TOKEN: \${{ secrets.TURBO_CACHE_TOKEN }}\n`;
    expect(writeTokenProblems(workflow)).toEqual([expect.stringContaining(trigger)]);
  });

  it('rejects the write token outside a GitHub Environment', () => {
    const workflow = 'on:\n  push:\njobs:\n  build:\n    env:\n      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n';
    expect(writeTokenProblems(workflow)).toEqual(['no job runs in a GitHub Environment']);
  });

  it('leaves read-token workflows alone', () => {
    const workflow =
      'on:\n  pull_request:\njobs:\n  ci:\n    env:\n      TURBO_TOKEN: ${{ secrets.TURBO_CACHE_READ_TOKEN }}\n';
    expect(writeTokenProblems(workflow)).toEqual([]);
  });

  it('keeps every repository workflow within the write-token rules', () => {
    const offenders = fs
      .readdirSync(WORKFLOW_DIR)
      .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
      .flatMap(file =>
        writeTokenProblems(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')).map(problem => `${file}: ${problem}`)
      );
    expect(offenders).toEqual([]);
  });
});
