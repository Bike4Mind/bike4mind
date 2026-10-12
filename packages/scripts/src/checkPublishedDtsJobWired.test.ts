import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readDefaultSpecs, readJobCondition, readJobs, readNeeds, readSteps } from './ciWorkflowText';

/**
 * Guard on ci.yml's `published-dts` job and the changes-filter wiring that triggers it.
 *
 * `published-dts` is the only leg that type-checks the packed @bike4mind/* declarations with lib
 * checking on. `ci-complete` is the only required check and a skipped job counts as passing, so
 * every link below fails quiet rather than red:
 *
 * - it is gated on `published-changed`, which the `changes` job must re-export from the action and
 *   the action must declare as an output; drop any hop and the `if` reads an empty string;
 * - it packs the dist/ that `core-build` produced, so it needs `core-build`;
 * - it is aggregated through `ci-complete`'s `needs`, env mapping and result loop;
 * - `published-paths` makes a change to the check itself, or to the lockfile that decides what gets
 *   installed, run the check.
 *
 * Text-matched rather than YAML-parsed, following checkHelpDocsJobWired.test.ts: the repo carries no
 * YAML parser dependency. The last describe runs the same helpers over deliberately broken copies,
 * so a parser that stops seeing the wiring turns red instead of turning every assertion above it
 * vacuously green.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const CHANGES_FILTER = path.join(REPO_ROOT, '.github', 'actions', 'changes-filter', 'action.yml');

/** The env var `ci-complete` maps `needs.published-dts.result` to, if it maps it at all. */
function readResultEnvVar(body: string): string | undefined {
  return /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*needs\.published-dts\.result\s*\}\}\s*$/m.exec(body)?.[1];
}

/** Whether the `for r in ...` loop that turns a failed leg red includes the env var. */
function resultLoopIncludes(body: string, envVar: string): boolean {
  return new RegExp(`^\\s*for r in .*"\\$${envVar}"`, 'm').test(body);
}

/** Whether a job body has a step that runs the published declaration check. */
function runsCheck(body: string): boolean {
  return /^\s*run:\s*node scripts\/check-published-dts\.mjs\s*$/m.test(body);
}

/** Whether the `changes` job re-exports the action's `published-changed` output. */
function exposesPublishedChanged(body: string): boolean {
  return /^ {6}published-changed:\s*\$\{\{\s*steps\.filter\.outputs\.published-changed\s*\}\}\s*$/m.test(body);
}

/** The text under `inputs.<key>` / `outputs.<key>` in action.yml, or undefined when it is not declared. */
function readActionEntry(action: string, section: 'inputs' | 'outputs', key: string): string | undefined {
  const lines = action.split('\n');
  const start = lines.findIndex(line => line === `${section}:`);
  if (start === -1) return undefined;

  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    sectionLines.push(line);
  }
  const entry = sectionLines.findIndex(line => line === `  ${key}:`);
  if (entry === -1) return undefined;

  const entryLines: string[] = [];
  for (const line of sectionLines.slice(entry + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    entryLines.push(line);
  }
  return `${entryLines.join('\n')}\n`;
}

const ci = fs.readFileSync(CI_WORKFLOW, 'utf8');
const action = fs.readFileSync(CHANGES_FILTER, 'utf8');
const jobs = readJobs(ci);
const jobBody = (name: string) => jobs.find(job => job.name === name)?.body ?? '';

describe('ci.yml job parsing', () => {
  // Anti-vacuity: every assertion below is an `expect` on something this parser found.
  it('finds the jobs the published-dts wiring spans', () => {
    const names = jobs.map(job => job.name);
    for (const name of ['changes', 'core-build', 'published-dts', 'ci-complete']) {
      expect(names).toContain(name);
    }
  });
});

describe('published-dts job in ci.yml', () => {
  const body = jobBody('published-dts');

  it('runs the published declaration check', () => {
    expect(runsCheck(body), 'published-dts no longer runs node scripts/check-published-dts.mjs').toBe(true);
  });

  it('needs both the changes gate and core-build', () => {
    const needs = readNeeds(body);
    expect(needs).toContain('changes');
    expect(needs).toContain('core-build');
  });

  it('gates on published-changed', () => {
    expect(readJobCondition(body)).toBe("needs.changes.outputs.published-changed == 'true'");
  });

  // A swallowed failure would leave the job green, so neither the job nor the check step may set it.
  it('does not continue on error', () => {
    const checkStep = readSteps(body).find(step => runsCheck(step));
    expect(checkStep, 'published-dts has no check step').toBeDefined();
    const jobLevel = body.split(/^ {4}steps:/m)[0];
    expect(jobLevel).not.toMatch(/continue-on-error:/);
    expect(checkStep).not.toMatch(/continue-on-error:/);
  });

  it('is aggregated into the required ci-complete check', () => {
    const ciComplete = jobBody('ci-complete');
    expect(readNeeds(ciComplete)).toContain('published-dts');

    const envVar = readResultEnvVar(ciComplete);
    expect(envVar, 'ci-complete does not map needs.published-dts.result into its env').toBeDefined();
    expect(
      resultLoopIncludes(ciComplete, envVar!),
      `ci-complete's result loop does not include $${envVar}; a failed published-dts would not redden it`
    ).toBe(true);
  });

  it('is fed by a changes job that exposes published-changed', () => {
    expect(exposesPublishedChanged(jobBody('changes'))).toBe(true);
  });
});

describe('changes-filter published-paths', () => {
  const input = readActionEntry(action, 'inputs', 'published-paths');
  const output = readActionEntry(action, 'outputs', 'published-changed');

  it('declares the published-paths input', () => {
    expect(input, 'action.yml declares no published-paths input').toBeDefined();
  });

  // published-dts is the only job that runs the script and fixture, so listing b4m-core alone
  // would let a change to the check skip the check; the lockfile decides what gets installed.
  it('covers b4m-core, the lockfile, the check itself and the CI wiring', () => {
    const specs = readDefaultSpecs(input ?? '');
    expect(specs).toContain('b4m-core/**');
    expect(specs).toContain('pnpm-lock.yaml');
    expect(specs).toContain('scripts/check-published-dts.mjs');
    expect(specs).toContain('scripts/fixtures/dangling-dts/**');
    expect(specs).toContain('.github/workflows/ci.yml');
    expect(specs).toContain('.github/actions/changes-filter/**');
  });

  it('declares the published-changed output, bound to the filter step', () => {
    expect(output, 'action.yml declares no published-changed output').toBeDefined();
    expect(output).toContain('value: ${{ steps.filter.outputs.published-changed }}');
  });
});

describe('the wiring checks reject a broken workflow', () => {
  /** Applies a mutation and fails if it changed nothing, so a stale pattern cannot pass vacuously. */
  function mutate(source: string, pattern: RegExp, replacement: string): string {
    const mutated = source.replace(pattern, replacement);
    expect(mutated, `mutation ${pattern} did not apply`).not.toBe(source);
    return mutated;
  }

  it('sees published-dts lose its core-build edge', () => {
    const broken = mutate(
      ci,
      /(\n {2}published-dts:\n(?: {4}.*\n)*? {4}needs:) \[changes, core-build\]/,
      '$1 [changes]'
    );
    expect(readNeeds(readJobs(broken).find(job => job.name === 'published-dts')!.body)).not.toContain('core-build');
  });

  it('sees published-dts dropped from the ci-complete result loop', () => {
    const broken = mutate(ci, / "\$PUBLISHED_DTS"/g, '');
    const ciComplete = readJobs(broken).find(job => job.name === 'ci-complete')!.body;
    expect(readResultEnvVar(ciComplete)).toBe('PUBLISHED_DTS');
    expect(resultLoopIncludes(ciComplete, 'PUBLISHED_DTS')).toBe(false);
  });

  it('sees a published-paths default that lost a path', () => {
    const broken = mutate(action, /^ {6}scripts\/fixtures\/dangling-dts\/\*\*\n/m, '');
    expect(readDefaultSpecs(readActionEntry(broken, 'inputs', 'published-paths')!)).not.toContain(
      'scripts/fixtures/dangling-dts/**'
    );
  });

  it('reads magic-prefixed pathspecs and block-list needs', () => {
    expect(readDefaultSpecs('    default: |\n      :(glob)b4m-core/**\n      pnpm-lock.yaml\n')).toEqual([
      'b4m-core/**',
      'pnpm-lock.yaml',
    ]);
    expect(readNeeds('    needs:\n      - changes\n      - core-build\n    if: x\n')).toEqual([
      'changes',
      'core-build',
    ]);
  });
});
