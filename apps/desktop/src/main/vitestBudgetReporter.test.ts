import { describe, expect, it } from 'vitest';
import { FILE_BUDGET_MS, TEST_BUDGET_MS, findBreaches } from '../../vitest.budgetReporter';

describe('findBreaches', () => {
  it('flags a test over its budget and leaves one exactly on it alone', () => {
    const breaches = findBreaches([
      {
        file: 'a.test.ts',
        ms: 900,
        tests: [
          { name: 'on the line', ms: TEST_BUDGET_MS },
          { name: 'over', ms: TEST_BUDGET_MS + 1 },
        ],
      },
    ]);
    expect(breaches).toEqual([{ kind: 'test', file: 'a.test.ts', name: 'over', ms: TEST_BUDGET_MS + 1 }]);
  });

  it('flags a file over its budget even when none of its tests is', () => {
    const breaches = findBreaches([
      { file: 'many.test.ts', ms: FILE_BUDGET_MS + 1, tests: [{ name: 'quick', ms: 10 }] },
      { file: 'fine.test.ts', ms: FILE_BUDGET_MS, tests: [] },
    ]);
    expect(breaches).toEqual([{ kind: 'file', file: 'many.test.ts', name: 'many.test.ts', ms: FILE_BUDGET_MS + 1 }]);
  });

  it('lists files before tests, each slowest first', () => {
    const breaches = findBreaches([
      { file: 'a.test.ts', ms: 6_000, tests: [{ name: 'slow', ms: 600 }] },
      { file: 'b.test.ts', ms: 9_000, tests: [{ name: 'slower', ms: 800 }] },
    ]);
    expect(breaches.map(breach => `${breach.kind}:${breach.name}`)).toEqual([
      'file:b.test.ts',
      'file:a.test.ts',
      'test:slower',
      'test:slow',
    ]);
  });
});
