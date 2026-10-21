import { describe, it, expect } from 'vitest';
import type { QaTestStatus } from '@bike4mind/common';
import { diffTests, median } from './runInsights';

const t = (testKey: string, status: QaTestStatus) => ({ testKey, title: `title ${testKey}`, status });
const ref = (testKey: string) => ({ testKey, title: `title ${testKey}` });

describe('median', () => {
  it('is null for nothing, the middle value for an odd count, the rounded mean of the middle two for an even count', () => {
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 41])).toBe(25);
    expect(median([1, 2])).toBe(2);
  });
  it('does not reorder its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('diffTests', () => {
  it('fills all four buckets by testKey', () => {
    const diff = diffTests(
      [t('a', 'failed'), t('b', 'passed'), t('c', 'passed'), t('new', 'passed')],
      [t('a', 'passed'), t('b', 'failed'), t('c', 'passed'), t('gone', 'passed')]
    );
    expect(diff).toEqual({
      newlyFailing: [ref('a')],
      recovered: [ref('b')],
      added: [ref('new')],
      removed: [ref('gone')],
    });
  });

  it('counts a flaky test that now fails as newly failing', () => {
    expect(diffTests([t('a', 'failed')], [t('a', 'flaky')]).newlyFailing).toEqual([ref('a')]);
  });

  it('does not report a still failing, skipped or flaky-now test', () => {
    const diff = diffTests(
      [t('a', 'failed'), t('b', 'flaky'), t('c', 'failed'), t('d', 'passed')],
      [t('a', 'failed'), t('b', 'failed'), t('c', 'skipped'), t('d', 'skipped')]
    );
    expect(diff).toEqual({ newlyFailing: [], recovered: [], added: [], removed: [] });
  });
});
