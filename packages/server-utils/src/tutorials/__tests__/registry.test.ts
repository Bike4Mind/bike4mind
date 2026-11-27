import { describe, it, expect } from 'vitest';
import { CORE_TUTORIALS, compareByCatalogue, resolveCoreTutorial } from '../registry';

describe('resolveCoreTutorial', () => {
  it('returns null for an unknown id', () => {
    expect(resolveCoreTutorial('no-such-module')).toBeNull();
  });

  it.each(['example-overlay', 'another-overlay'])('returns null for the overlay id %s', id => {
    expect(resolveCoreTutorial(id)).toBeNull();
  });

  it('resolves every entry of the core array, and only those', () => {
    for (const tutorial of CORE_TUTORIALS) expect(resolveCoreTutorial(tutorial.id)).toBe(tutorial);
  });
});

describe('compareByCatalogue', () => {
  const registry = [{ id: 'late' }, { id: 'second', order: 20 }, { id: 'first', order: 10 }, { id: 'also-late' }];
  const ids = (list: { id: string }[]) => list.map(t => t.id);

  it('lists by order, then unordered entries in registry order, then ids the registry does not know', () => {
    const modules = [{ id: 'stranger' }, { id: 'also-late' }, { id: 'late' }, { id: 'second' }, { id: 'first' }];
    expect(ids([...modules].sort(compareByCatalogue(registry)))).toEqual([
      'first',
      'second',
      'late',
      'also-late',
      'stranger',
    ]);
  });

  it('keeps registry order between entries with the same order', () => {
    const tied = [
      { id: 'b', order: 5 },
      { id: 'a', order: 5 },
    ];
    expect(ids([{ id: 'a' }, { id: 'b' }].sort(compareByCatalogue(tied)))).toEqual(['b', 'a']);
  });
});
