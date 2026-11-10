import { describe, it, expect } from 'vitest';
import {
  applyJsonMergePatch,
  CreateCustomPageInput,
  PageIdSchema,
  PageWidgetSchema,
  PatchPageStateInput,
  PAGE_QUERY_KEY,
} from './customPage';

describe('applyJsonMergePatch', () => {
  it('merges nested objects without mutating the inputs', () => {
    const target = { a: 1, nested: { x: 1, y: 2 } };
    const patch = { nested: { y: 3, z: 4 }, b: 'new' };
    const result = applyJsonMergePatch(target, patch);
    expect(result).toEqual({ a: 1, b: 'new', nested: { x: 1, y: 3, z: 4 } });
    expect(target).toEqual({ a: 1, nested: { x: 1, y: 2 } });
    expect(patch).toEqual({ nested: { y: 3, z: 4 }, b: 'new' });
  });

  it('deletes keys whose patch value is null, at any depth', () => {
    expect(applyJsonMergePatch({ a: 1, b: { c: 1, d: 2 } }, { a: null, b: { c: null } })).toEqual({ b: { d: 2 } });
  });

  it('replaces arrays instead of merging them', () => {
    expect(applyJsonMergePatch({ list: [1, 2, 3] }, { list: [4] })).toEqual({ list: [4] });
  });

  it('replaces a scalar with an object and an object with a scalar', () => {
    expect(applyJsonMergePatch({ a: 'x' }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
    expect(applyJsonMergePatch({ a: { b: 1 } }, { a: 2 })).toEqual({ a: 2 });
  });

  it('returns a non-object patch as the result (RFC 7386)', () => {
    expect(applyJsonMergePatch({ a: 1 }, [1])).toEqual([1]);
    expect(applyJsonMergePatch({ a: 1 }, 'x')).toBe('x');
  });

  it('ignores prototype-polluting keys', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const result = applyJsonMergePatch({}, patch) as Record<string, unknown>;
    expect(result).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('PageWidgetSchema', () => {
  it('accepts each widget type and defaults checklist items to unchecked', () => {
    expect(
      PageWidgetSchema.safeParse({ id: 'cookable', type: 'card-list', items: [{ id: '1', title: 'Omelette' }] }).success
    ).toBe(true);
    expect(PageWidgetSchema.safeParse({ id: 'recipe', type: 'markdown', markdown: '# Hi' }).success).toBe(true);
    const parsed = PageWidgetSchema.parse({
      id: 'shopping-list',
      type: 'checklist',
      items: [{ id: 'a', label: 'Milk' }],
    });
    expect(parsed.type === 'checklist' && parsed.items[0].checked).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(PageWidgetSchema.safeParse({ id: 'x', type: 'react', code: '<div/>' }).success).toBe(false);
  });

  it('rejects an invalid widget id', () => {
    expect(PageWidgetSchema.safeParse({ id: 'Bad Id', type: 'markdown', markdown: '' }).success).toBe(false);
    expect(PageWidgetSchema.safeParse({ id: '-lead', type: 'markdown', markdown: '' }).success).toBe(false);
    expect(PageWidgetSchema.safeParse({ id: 'a'.repeat(65), type: 'markdown', markdown: '' }).success).toBe(false);
  });

  it('rejects oversized content and missing fields', () => {
    expect(PageWidgetSchema.safeParse({ id: 'r', type: 'markdown', markdown: 'x'.repeat(20_001) }).success).toBe(false);
    const items = Array.from({ length: 51 }, (_, i) => ({ id: String(i), title: 't' }));
    expect(PageWidgetSchema.safeParse({ id: 'c', type: 'card-list', items }).success).toBe(false);
    expect(PageWidgetSchema.safeParse({ id: 'c', type: 'checklist' }).success).toBe(false);
  });
});

describe('inputs', () => {
  it('trims and requires a page name', () => {
    expect(CreateCustomPageInput.parse({ name: '  Daily menu ' }).name).toBe('Daily menu');
    expect(CreateCustomPageInput.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('requires a patch object for state updates', () => {
    expect(PatchPageStateInput.safeParse({ patch: { a: 1 } }).success).toBe(true);
    expect(PatchPageStateInput.safeParse({ patch: [1] }).success).toBe(false);
  });

  it('validates page ids and builds the query key', () => {
    expect(PageIdSchema.safeParse('6a1fb3d3e310bb516192e8c8').success).toBe(true);
    expect(PageIdSchema.safeParse('nope').success).toBe(false);
    expect(PAGE_QUERY_KEY('p1')).toEqual(['custom-page', 'p1']);
  });
});
