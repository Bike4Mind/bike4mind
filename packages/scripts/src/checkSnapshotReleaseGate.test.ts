import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../../.github/workflows/release.yaml', import.meta.url), 'utf8');
const snapshotJob = /^ {2}snapshot:\n((?:[ \t]+[^\n]*\n|\n)*)/m.exec(workflow)?.[1];
const condition = /^ {4}if: >-\n((?: {6}[^\n]*\n)+)/m.exec(snapshotJob ?? '')?.[1].trim();

type GateInput = {
  branch?: string;
  eventName?: string;
  conclusion?: string;
  repository?: string;
  canonicalRepository?: string;
  runEvent?: string;
  headRepository?: string;
  path?: string;
};

function snapshotEnabled({
  branch = 'feat/example',
  eventName = 'workflow_run',
  conclusion = 'success',
  repository = 'Bike4Mind/bike4mind',
  canonicalRepository = 'Bike4Mind/bike4mind',
  runEvent = 'push',
  headRepository = repository,
  path = '.github/workflows/test.yaml',
}: GateInput): unknown {
  if (!condition) throw new Error('Missing snapshot job condition in release.yaml');

  // For these lowercase string fixtures, this condition shares JS/Actions comparison semantics.
  return runInNewContext(condition, {
    github: {
      event_name: eventName,
      repository,
      event:
        eventName === 'workflow_run'
          ? {
              workflow_run: {
                head_branch: branch,
                conclusion,
                event: runEvent,
                head_repository: { full_name: headRepository },
                path,
              },
            }
          : {},
    },
    vars: { CANONICAL_REPO: canonicalRepository },
    // Actions' startsWith ignores case.
    startsWith: (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase()),
  });
}

describe('release snapshot gate', () => {
  it.each([
    ['release PR branch', 'changeset-release/main', false],
    ['main branch', 'main', false],
    ['feature branch', 'feat/example', true],
    ['nested feature branch', 'fix/release/main', true],
    ['similarly named feature branch', 'changeset-release/main-fix', true],
    ['merge queue branch', 'gh-readonly-queue/main/pr-1-abc123', false],
  ] as const)('%s', (_name, branch, expected) => {
    expect(snapshotEnabled({ branch })).toBe(expected);
  });

  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', ''])('skips %s runs', conclusion => {
    expect(snapshotEnabled({ conclusion })).toBe(false);
  });

  it.each(['push', 'workflow_dispatch', 'pull_request'])('skips %s events', eventName => {
    expect(snapshotEnabled({ eventName })).toBe(false);
  });

  it.each(['pull_request', 'pull_request_target', 'workflow_dispatch'])('skips runs triggered by %s', runEvent => {
    expect(snapshotEnabled({ runEvent })).toBe(false);
  });

  it('skips runs whose head is in another repository', () => {
    expect(snapshotEnabled({ headRepository: 'example/fork' })).toBe(false);
  });

  it('skips completions of any workflow other than Branch Tests', () => {
    expect(snapshotEnabled({ path: '.github/workflows/other.yaml' })).toBe(false);
  });

  it('skips repositories other than the configured canonical repository', () => {
    expect(snapshotEnabled({ repository: 'example/fork' })).toBe(false);
  });

  it('supports a configured canonical repository', () => {
    expect(snapshotEnabled({ repository: 'example/project', canonicalRepository: 'example/project' })).toBe(true);
  });

  it('retains the canonical repository fallback when the variable is unset', () => {
    expect(snapshotEnabled({ repository: 'MillionOnMars/lumina5', canonicalRepository: '' })).toBe(true);
    expect(snapshotEnabled({ canonicalRepository: '' })).toBe(false);
  });
});
