import { describe, expect, it } from 'vitest';
import type { IMemento } from '@bike4mind/common';
import { buildMementosCSV } from './mementoHelpers';

const memento = (overrides: Partial<IMemento>): IMemento =>
  ({
    userId: 'u1',
    sessionId: null,
    type: 'fact',
    tier: 'core',
    weight: 1,
    summary: 'Likes tea',
    fullContent: 'Prefers green tea, "no sugar"',
    lastAccessedAt: new Date('2026-11-01T00:00:00Z'),
    isArchived: false,
    tags: ['drink', 'tea'],
    embedding: [0.5, 0.25],
    ...overrides,
  }) as IMemento;

describe('buildMementosCSV', () => {
  it('writes a header and one RFC 4180 row per memento', () => {
    const [header, row] = buildMementosCSV([memento({})]).split('\n');
    expect(header).toBe('Type,Tier,Weight,Summary,Full Content,Last Accessed,Tags,Embedding');
    expect(row).toBe(
      'fact,core,1,Likes tea,"Prefers green tea, ""no sugar""",2026-11-01T00:00:00.000Z,drink;tea,0.5;0.25'
    );
  });

  it.each(['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralises a cell that a spreadsheet would read as a formula: %j',
    payload => {
      const csv = buildMementosCSV([memento({ summary: payload, fullContent: payload, tags: [payload] })]);
      const row = csv.split('\n').slice(1).join('\n');
      expect(row).not.toMatch(/(^|,)"?[=+\-@\t\r]/);
      expect(row).toContain(`'${payload.charAt(0)}`);
    }
  );
});
