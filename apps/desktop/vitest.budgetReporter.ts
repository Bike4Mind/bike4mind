import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';

export const TEST_BUDGET_MS = 500;
export const FILE_BUDGET_MS = 5_000;

/** GitHub shows at most ten annotations of one level per step, so the rest go to the summary only. */
const MAX_ANNOTATIONS = 10;

export interface BudgetBreach {
  kind: 'test' | 'file';
  file: string;
  name: string;
  ms: number;
}

/** One module's timings, as the reporter reads them from vitest. */
export interface ModuleTiming {
  file: string;
  ms: number;
  tests: readonly { name: string; ms: number }[];
}

/** Every test over TEST_BUDGET_MS and every file over FILE_BUDGET_MS, slowest first within each kind. */
export function findBreaches(modules: readonly ModuleTiming[]): BudgetBreach[] {
  const slowest = (a: BudgetBreach, b: BudgetBreach) => b.ms - a.ms;
  const files = modules
    .filter(module => module.ms > FILE_BUDGET_MS)
    .map((module): BudgetBreach => ({ kind: 'file', file: module.file, name: module.file, ms: module.ms }));
  const tests = modules.flatMap(module =>
    module.tests
      .filter(test => test.ms > TEST_BUDGET_MS)
      .map((test): BudgetBreach => ({ kind: 'test', file: module.file, name: test.name, ms: test.ms }))
  );
  return [...files.sort(slowest), ...tests.sort(slowest)];
}

function timingOf(module: TestModule, root: string): ModuleTiming {
  return {
    file: relative(root, module.moduleId),
    ms: module.diagnostic().duration,
    tests: [...module.children.allTests()].map(test => ({
      name: test.fullName,
      ms: test.diagnostic()?.duration ?? 0,
    })),
  };
}

function where(breach: BudgetBreach): string {
  return breach.kind === 'file' ? breach.file : `${breach.file} > ${breach.name}`;
}

function line(breach: BudgetBreach): string {
  const budget = breach.kind === 'file' ? FILE_BUDGET_MS : TEST_BUDGET_MS;
  return `${Math.round(breach.ms)}ms (budget ${budget}ms) ${where(breach)}`;
}

/**
 * Flags tests and files over their time budget at the end of a run: in the terminal, and on GitHub
 * Actions as warning annotations and a job summary. It fails the run only when
 * B4M_TEST_BUDGET=enforce, since a loaded machine can push an honest test over for one run.
 */
export default class BudgetReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: { config: { root: string } }): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    const breaches = findBreaches(modules.map(module => timingOf(module, this.root)));
    if (breaches.length === 0) return;

    const files = breaches.filter(breach => breach.kind === 'file');
    const tests = breaches.filter(breach => breach.kind === 'test');
    const heading = `Test time budget: ${files.length} file(s) over ${FILE_BUDGET_MS}ms, ${tests.length} test(s) over ${TEST_BUDGET_MS}ms`;
    console.warn(`\n${heading}`);
    for (const breach of breaches) console.warn(`  ${line(breach)}`);

    if (process.env.GITHUB_ACTIONS) {
      for (const breach of breaches.slice(0, MAX_ANNOTATIONS)) {
        console.warn(`::warning file=apps/desktop/${breach.file},title=Test time budget::${line(breach)}`);
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = breaches.map(
        breach => `| ${breach.kind} | ${Math.round(breach.ms)} | ${where(breach).replaceAll('|', '\\|')} |`
      );
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [`### ${heading}`, '', '| kind | ms | where |', '| --- | --- | --- |', ...rows, ''].join('\n')
      );
    }
    if (process.env.B4M_TEST_BUDGET === 'enforce') process.exitCode = 1;
  }
}
