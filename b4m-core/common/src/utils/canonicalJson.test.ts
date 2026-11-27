import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonicalJson';

describe('canonicalJson', () => {
  it('writes the same text whatever the key order, at every depth', () => {
    const a = { span: 5, load: { value: 2, unit: 'N/m' }, points: [{ y: 1, x: 0 }] };
    const b = { points: [{ x: 0, y: 1 }], load: { unit: 'N/m', value: 2 }, span: 5 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"load":{"unit":"N/m","value":2},"points":[{"x":0,"y":1}],"span":5}');
  });

  it('keeps array order and drops undefined keys', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
