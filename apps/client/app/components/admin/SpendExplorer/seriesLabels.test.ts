import { describe, expect, it } from 'vitest';
import { seriesLabel } from './seriesLabels';

describe('platform cost series labels', () => {
  it('identifies platform operations independently from internal customers and credit funding', () => {
    expect(seriesLabel('segment', 'platform')).toBe('Platform operations');
    expect(seriesLabel('funding', 'platform')).toBe('Platform operations');
    expect(seriesLabel('segment', 'internal')).toBe('Internal');
    expect(seriesLabel('funding', 'unknown')).toBe('Unattributed');
  });
});
