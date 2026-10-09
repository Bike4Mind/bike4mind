import { describe, it, expect } from 'vitest';
import type { QaTestView } from '@client/app/hooks/data/qaStatus';
import { groupTests, testGroupName } from './testGroups';

const view = (testKey: string, o: Partial<QaTestView> = {}): QaTestView => ({
  testKey,
  title: testKey.split(' > ').slice(1).join(' > '),
  status: 'passed',
  durationMs: 1000,
  retries: 0,
  media: [],
  ...o,
});

describe('testGroupName', () => {
  it('matches the suite chip names built in scripts/qa-report.mjs', () => {
    expect(testGroupName('auth.spec.ts > Auth > logs in')).toBe('Auth');
    expect(testGroupName('e2e/mfa-setup.spec.ts > Mfa > enrolls')).toBe('Mfa Setup');
    expect(testGroupName('e2e/prompt_library.spec.ts > Prompts > saves')).toBe('Prompt Library');
  });
  it('prefixes the label of a multi-project run', () => {
    expect(testGroupName('tenant-a::e2e/signup.spec.ts > Signup > works [chromium]')).toBe('tenant-a Signup');
  });
});

describe('groupTests', () => {
  it('puts failing groups first, then sorts by name, with the slowest test first in a group', () => {
    const groups = groupTests([
      view('b.spec.ts > B > fast', { durationMs: 10 }),
      view('b.spec.ts > B > slow', { durationMs: 900 }),
      view('c.spec.ts > C > broken', { status: 'failed' }),
      view('a.spec.ts > A > ok'),
    ]);
    expect(groups.map(g => [g.name, g.failed])).toEqual([
      ['C', 1],
      ['A', 0],
      ['B', 0],
    ]);
    expect(groups[2].tests.map(t => t.title)).toEqual(['B > slow', 'B > fast']);
  });
});
