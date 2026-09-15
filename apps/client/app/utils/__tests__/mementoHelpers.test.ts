import { describe, it, expect } from 'vitest';
import { calculateMemoryUsage, calculateTierMemoryUsage, buildMementosCSV, removeTag } from '../mementoHelpers';
import { MementoTier, MementoType, IMemento } from '@bike4mind/common';

const makeMemo = (overrides: Partial<IMemento>): IMemento => ({
  userId: 'u1',
  sessionId: 's1',
  type: MementoType.INSIGHT,
  tier: MementoTier.HOT,
  weight: 500,
  summary: 'summary',
  fullContent: 'content',
  lastAccessedAt: new Date(),
  isArchived: false,
  tags: [],
  ...overrides,
});

describe('mementoHelpers', () => {
  it('calculateMemoryUsage counts summary + fullContent + tags characters', () => {
    const memos: IMemento[] = [makeMemo({ summary: 'abc', fullContent: 'defgh', tags: ['x', 'yz'] })];
    // 3 + 5 + 3 = 11
    expect(calculateMemoryUsage(memos)).toBe(11);
  });

  it('calculateTierMemoryUsage limits to given tier', () => {
    const memos: IMemento[] = [
      makeMemo({ tier: MementoTier.HOT, summary: 'a', fullContent: 'b' }), // 2 chars
      makeMemo({ tier: MementoTier.WARM, summary: 'aa', fullContent: 'bb' }), // 4 chars
    ];
    expect(calculateTierMemoryUsage(memos, MementoTier.HOT)).toBe(2);
    expect(calculateTierMemoryUsage(memos, MementoTier.WARM)).toBe(4);
  });

  it('buildMementosCSV produces header and rows', () => {
    const memos: IMemento[] = [makeMemo({ summary: 'hello', fullContent: 'world' })];
    const csv = buildMementosCSV(memos);
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^Type,Tier,Weight/);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('hello');
  });

  it('removeTag removes the specified tag', () => {
    expect(removeTag(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});
