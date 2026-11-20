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

  describe('buildMementosCSV escaping', () => {
    it('writes a header and one RFC 4180 row per memento', () => {
      const [header, row] = buildMementosCSV([
        makeMemo({
          summary: 'Likes tea',
          fullContent: 'Prefers green tea, "no sugar"',
          lastAccessedAt: new Date('2026-11-01T00:00:00Z'),
          tags: ['drink', 'tea'],
          embedding: [0.5, 0.25],
        }),
      ]).split('\n');
      expect(header).toBe('Type,Tier,Weight,Summary,Full Content,Last Accessed,Tags,Embedding');
      expect(row).toContain(',Likes tea,"Prefers green tea, ""no sugar""",2026-11-01T00:00:00.000Z,drink;tea,0.5;0.25');
    });

    it.each(['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
      'neutralises a cell that a spreadsheet would read as a formula: %j',
      payload => {
        const csv = buildMementosCSV([makeMemo({ summary: payload, fullContent: payload, tags: [payload] })]);
        const row = csv.split('\n').slice(1).join('\n');
        expect(row).not.toMatch(/(^|,)"?[=+\-@\t\r]/);
        expect(row).toContain(`'${payload.charAt(0)}`);
      }
    );

    it('leaves a negative first embedding value unprefixed', () => {
      const [, row] = buildMementosCSV([makeMemo({ embedding: [-0.5, 0.25] })]).split('\n');
      expect(row.endsWith(',-0.5;0.25')).toBe(true);
    });
  });
});
