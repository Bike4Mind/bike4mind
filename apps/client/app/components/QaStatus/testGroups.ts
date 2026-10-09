import type { QaTestView } from '@client/app/hooks/data/qaStatus';

export interface TestGroup {
  name: string;
  /** Slowest first. */
  tests: QaTestView[];
  failed: number;
}

/** Same naming as suiteDisplayName in scripts/qa-report.mjs, so groups line up with the suite chips. */
function suiteDisplayName(title: string): string {
  return title
    .replace(/e2e\//g, '')
    .replace(/\.spec\.ts$/, '')
    .split('-')
    .flatMap(part => part.split('_'))
    .map(word => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ');
}

/** `[label::]file > title` -> the suiteSummary name for that file ("label Auth"); keys are built in parseResults. */
export function testGroupName(testKey: string): string {
  const head = testKey.split(' > ')[0];
  const sep = head.indexOf('::');
  const label = sep >= 0 ? head.slice(0, sep) : '';
  const file = sep >= 0 ? head.slice(sep + 2) : head;
  return `${label ? `${label} ` : ''}${suiteDisplayName(file)}`;
}

/** Groups with failures first, then by name; slowest test first inside each group. */
export function groupTests(tests: readonly QaTestView[]): TestGroup[] {
  const groups = new Map<string, TestGroup>();
  for (const test of tests) {
    const name = testGroupName(test.testKey);
    const group = groups.get(name) ?? { name, tests: [], failed: 0 };
    group.tests.push(test);
    if (test.status === 'failed') group.failed += 1;
    groups.set(name, group);
  }
  for (const group of groups.values()) {
    group.tests.sort((a, b) => b.durationMs - a.durationMs || a.title.localeCompare(b.title));
  }
  return [...groups.values()].sort(
    (a, b) => Number(b.failed > 0) - Number(a.failed > 0) || a.name.localeCompare(b.name)
  );
}
