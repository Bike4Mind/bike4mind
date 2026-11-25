import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on: { pull_request: { types: string[]; paths?: string[]; 'paths-ignore'?: string[] } };
  concurrency: { group: string; 'cancel-in-progress': string | boolean };
  jobs: Record<string, Job>;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const names = ['ci', 'audit-gate', 'lambda-bundle-guard', 'opennext-build-guard'];
const sources = names.map(name => fs.readFileSync(path.join(root, `.github/workflows/${name}.yml`), 'utf8'));
const workflows = sources.map(source => parse(source) as Workflow);
const ci = workflows[0];

// These workflow expressions use the JS-compatible subset of GitHub's expression language.
function evaluate(expression: string, context: Record<string, unknown>) {
  const body = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/labels\.\*\.name/g, 'labels.map(label => label.name)')
    .replace(/\.([\w]+-[\w-]+)/g, "['$1']");
  return runInNewContext(body, {
    contains: (values: string[], value: string) => values.includes(value),
    cancelled: () => false,
    ...context,
  });
}

function context(action = 'synchronize', labels: string[] = [], draft = true, eventName = 'pull_request') {
  return {
    github: {
      event_name: eventName,
      event: {
        action,
        pull_request: { draft, number: 42, labels: labels.map(name => ({ name })) },
      },
      workflow: 'CI',
      ref: 'refs/heads/main',
    },
    steps: { filter: { outputs: { deployable: 'true', 'docs-changed': 'true', 'published-changed': 'true' } } },
  };
}

function group(ctx: ReturnType<typeof context>) {
  return ci.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluate(expression, ctx)));
}

function aggregate(jobName: string, overrides: Record<string, string> = {}) {
  const step = ci.jobs[jobName].steps!.at(-1)!;
  const env = Object.fromEntries(Object.keys(step.env!).map(key => [key, 'success']));
  return spawnSync('bash', ['-e', '-c', step.run!], {
    cwd: root,
    env: { ...process.env, ...env, DEPLOYABLE: 'true', ...overrides },
    encoding: 'utf8',
  }).status;
}

describe('draft CI execution', () => {
  it.each(names)('%s runs opened/synchronize/reopened without a ready transition rerun', name => {
    const index = names.indexOf(name);
    expect(workflows[index].on.pull_request.types).toEqual(
      expect.arrayContaining(['opened', 'synchronize', 'reopened'])
    );
    expect(workflows[index].on.pull_request.types).not.toContain('ready_for_review');
    expect(sources[index]).not.toMatch(/pull_request\.draft/);
  });

  it.each(['opened', 'synchronize', 'reopened'])('%s passes real change signals for draft and ready PRs', action => {
    for (const draft of [true, false]) {
      const ctx = context(action, [], draft);
      for (const output of ['deployable', 'docs-changed', 'published-changed']) {
        expect(evaluate(ci.jobs.changes.outputs![output], ctx), output).toBe('true');
      }
      ctx.steps.filter.outputs.deployable = 'false';
      ctx.steps.filter.outputs['docs-changed'] = 'false';
      expect(evaluate(ci.jobs.changes.outputs!.deployable, ctx)).toBe('false');
      expect(evaluate(ci.jobs.changes.outputs!['docs-changed'], ctx)).toBe('false');
    }
  });

  it('keeps applicability inside required CI and path filters on optional guards', () => {
    expect(ci.on.pull_request.paths).toBeUndefined();
    expect(ci.on.pull_request['paths-ignore']).toBeUndefined();
    for (const workflow of workflows.slice(1)) expect(workflow.on.pull_request.paths!.length).toBeGreaterThan(0);
    expect(ci.jobs['core-build'].steps!.find(step => step.id === 'affected')!.run).toBe(
      'node scripts/ci-affected-tests.mjs plan'
    );
    expect(ci.jobs['test-shards'].steps!.find(step => step.id === 'select')!.run).toBe(
      'node scripts/ci-affected-tests.mjs shard'
    );
  });
});

describe('full CI without label reruns', () => {
  it('has no label trigger, so a label change cannot replace the required checks', () => {
    expect(ci.on.pull_request.types).not.toContain('labeled');
    expect(ci.on.pull_request.types).not.toContain('unlabeled');
    expect(ci.jobs.changes.if).toBeUndefined();
    expect(group(context())).toBe('ci-CI-42');
  });

  it('forces a full deployable run on drafts too, and keeps diff selection without ci:full', () => {
    const diff = ci.jobs.changes.steps!.find(step => step.id === 'changed-files')!;
    const full = context('synchronize', ['ci:full']);
    full.steps.filter.outputs.deployable = 'false';
    expect(evaluate(ci.jobs.changes.outputs!.deployable, full)).toBe('true');
    expect(evaluate(diff.if!, full)).toBe(false);
    expect(evaluate(diff.if!, context())).toBe(true);
    expect(ci.jobs.changes.outputs!['changed-files']).toBe('${{ steps.changed-files.outputs.files }}');
    expect(ci.jobs['core-build'].steps!.find(step => step.id === 'affected')!.env!.CHANGED_FILES).toBe(
      '${{ needs.changes.outputs.changed-files }}'
    );
    expect(evaluate(diff.if!, context('', [], false, 'push'))).toBe(false);
    expect(evaluate(String(ci.concurrency['cancel-in-progress']), context('', [], false, 'push'))).toBe(false);
    expect(evaluate(String(ci.concurrency['cancel-in-progress']), context())).toBe(true);
  });
});

describe('required-check aggregation for skipped and unaffected work', () => {
  it('does not report completion when selection did not run or the run was cancelled', () => {
    const condition = ci.jobs['ci-complete'].if!;
    expect(evaluate(condition, { needs: { changes: { result: 'skipped' } } })).toBe(false);
    expect(evaluate(condition, { needs: { changes: { result: 'failure' } } })).toBe(true);
    expect(evaluate(condition, { needs: { changes: { result: 'success' } }, cancelled: () => true })).toBe(false);
  });

  it('skips Run Tests only for non-deployable work, not failed shards', () => {
    const condition = ci.jobs.test.if!;
    expect(evaluate(condition, { needs: { changes: { outputs: { deployable: 'false' } } } })).toBe(false);
    expect(evaluate(condition, { needs: { changes: { outputs: { deployable: 'true' } } } })).toBe(true);
    expect(aggregate('test')).toBe(0);
    for (const result of ['failure', 'skipped', 'cancelled']) {
      expect(aggregate('test', { SHARDS_RESULT: result }), result).not.toBe(0);
      expect(aggregate('ci-complete', { TEST_SHARDS: result }), result).not.toBe(0);
    }
  });

  it('allows legitimate skips but fails each failed prerequisite', () => {
    expect(aggregate('ci-complete')).toBe(0);
    const skipped = Object.fromEntries(
      Object.keys(ci.jobs['ci-complete'].steps!.at(-1)!.env!).map(key => [key, 'skipped'])
    );
    expect(
      aggregate('ci-complete', {
        ...skipped,
        CHANGES: 'success',
        SECRET_SCAN: 'success',
        LEAK_SHAPES: 'success',
        DEPLOYABLE: 'false',
      })
    ).toBe(0);
    for (const key of Object.keys(skipped).filter(key => key !== 'DEPLOYABLE')) {
      expect(aggregate('ci-complete', { [key]: 'failure' }), key).not.toBe(0);
    }
  });

  it('maps all aggregate prerequisites and rejects missing wiring', () => {
    const job = ci.jobs['ci-complete'];
    expect(job.needs).toEqual(expect.arrayContaining(['changes', 'test-shards', 'secret-scan', 'leak-shapes']));
    for (const need of job.needs as string[]) {
      expect(Object.values(job.steps!.at(-1)!.env!)).toContain(`\${{ needs.${need}.result }}`);
    }
  });
});
