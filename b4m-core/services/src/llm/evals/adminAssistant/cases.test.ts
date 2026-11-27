import { VIEW_REGISTRY } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { ADMIN_EVAL_CASES, ADMIN_EVAL_CATEGORIES, CALLABLE_ADMIN_TOOLS } from './cases';

describe('admin eval cases', () => {
  it('has unique ids', () => {
    const ids = ADMIN_EVAL_CASES.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ADMIN_EVAL_CATEGORIES)('has at least 5 %s rows', category => {
    expect(ADMIN_EVAL_CASES.filter(c => c.category === category).length).toBeGreaterThanOrEqual(5);
  });

  it('expects only admin views that exist', () => {
    const adminViews = new Set(VIEW_REGISTRY.filter(v => v.requiresAdmin).map(v => v.id));
    const unknown = ADMIN_EVAL_CASES.flatMap(c => c.expectViewIds ?? []).filter(id => !adminViews.has(id));
    expect(unknown).toEqual([]);
  });

  it('expects only tools the assistant can call', () => {
    const unknown = ADMIN_EVAL_CASES.flatMap(c => c.expectTools ?? []).filter(n => !CALLABLE_ADMIN_TOOLS.includes(n));
    expect(unknown).toEqual([]);
  });

  it('gives every row something to check, and compiles its patterns', () => {
    for (const c of ADMIN_EVAL_CASES) {
      expect(c.expectViewIds?.length || c.expectTools?.length || c.declines, c.id).toBeTruthy();
      for (const src of [...(c.expect ?? []), ...(c.reject ?? [])])
        expect(() => new RegExp(src, 'i'), c.id).not.toThrow();
    }
  });

  it('only declines out of scope', () => {
    for (const c of ADMIN_EVAL_CASES) expect(Boolean(c.declines), c.id).toBe(c.category === 'out-of-scope');
  });

  it('uses the seeded target only where it names it', () => {
    for (const c of ADMIN_EVAL_CASES) expect(c.question.includes('{target}'), c.id).toBe(Boolean(c.needsTarget));
  });
});
