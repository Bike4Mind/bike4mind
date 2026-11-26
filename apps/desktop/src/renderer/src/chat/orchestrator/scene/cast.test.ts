import { describe, expect, it } from 'vitest';
import { assignSheets } from './cast';

describe('assignSheets', () => {
  const subject = (id: string, minute: number, epithet?: 'Scribe' | 'Tinkerer') => ({
    id,
    createdAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
    ...(epithet && { epithet }),
  });

  it('gives every sheet out once before any repeats, and is stable across calls', () => {
    const agents = Array.from({ length: 6 }, (_, index) => subject(`a${index}`, index));
    const sheets = assignSheets(agents, [undefined, undefined, undefined]);
    const first = [0, 1, 2].map(index => sheets.get(`a${index}`));
    expect(new Set(first).size).toBe(3);
    expect(assignSheets([...agents].reverse(), [undefined, undefined, undefined])).toEqual(sheets);
  });

  it('prefers a free sheet whose craft matches the agent epithet', () => {
    const sheets = assignSheets([subject('a', 0, 'Scribe')], ['Tinkerer', undefined, 'Scribe']);
    expect(sheets.get('a')).toBe(2);
  });

  it('refuses an empty cast', () => {
    expect(() => assignSheets([subject('a', 0)], [])).toThrow('empty cast');
  });
});
