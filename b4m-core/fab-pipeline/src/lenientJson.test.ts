import { describe, expect, it } from 'vitest';
import { parseLenientJson, stripBom } from './lenientJson';

describe('parseLenientJson', () => {
  it('parses strict JSON exactly like JSON.parse', () => {
    const text = '{"a":[1,2,{"b":"c"}],"d":null}';
    expect(parseLenientJson(text)).toEqual(JSON.parse(text));
  });

  it('accepts trailing commas in objects and arrays', () => {
    expect(parseLenientJson('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it('accepts line and block comments', () => {
    const text = '{\n  // lead\n  "a": 1, /* inline */\n  "b": 2 // tail\n}';
    expect(parseLenientJson(text)).toEqual({ a: 1, b: 2 });
  });

  it('does not fuse tokens that a block comment separated', () => {
    expect(() => parseLenientJson('[1/* gap */2]')).toThrow(SyntaxError);
    expect(parseLenientJson('[1/* gap */,2]')).toEqual([1, 2]);
  });

  it('reports a failed parse against the original text, not the cleaned text', () => {
    const text = '{\n  // a long leading comment that shifts offsets\n  "a": nope,\n}';
    const strictMessage = (() => {
      try {
        JSON.parse(text);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();

    expect(() => parseLenientJson(text)).toThrow(strictMessage);
  });

  it('accepts a trailing comma followed by a comment before the closer', () => {
    expect(parseLenientJson('[1, 2, // last\n]')).toEqual([1, 2]);
  });

  it('accepts a leading UTF-8 BOM with CRLF line endings', () => {
    expect(parseLenientJson('\uFEFF{\r\n  "y": 1\r\n}')).toEqual({ y: 1 });
  });

  it('leaves comment-like and comma-bracket text inside strings untouched', () => {
    const text = '{"url":"http://x.test/a","re":"/* not a comment */","list":"a,]","q":"say \\"//\\"",}';
    expect(parseLenientJson(text)).toEqual({
      url: 'http://x.test/a',
      re: '/* not a comment */',
      list: 'a,]',
      q: 'say "//"',
    });
  });

  it('does not treat a comma with no preceding member as trailing', () => {
    expect(() => parseLenientJson('{,}')).toThrow(SyntaxError);
    expect(() => parseLenientJson('[,]')).toThrow(SyntaxError);
    expect(() => parseLenientJson('[1,,]')).toThrow(SyntaxError);
    expect(() => parseLenientJson('{"a":1,,}')).toThrow(SyntaxError);
  });

  it('still drops a trailing comma after a nested value or a comment', () => {
    expect(parseLenientJson('{"a":{"b":[1,2],},"c":"x", /* tail */ }')).toEqual({ a: { b: [1, 2] }, c: 'x' });
  });

  it('does not drop everything after an unterminated block comment', () => {
    expect(() => parseLenientJson('{"a":1}\n/*\n{"b":2}')).toThrow(SyntaxError);
    expect(() => parseLenientJson('{"a":1} /* oops')).toThrow(SyntaxError);
  });

  it('treats a lone CR as the end of a line comment', () => {
    expect(parseLenientJson('{"a":1, // note\r"b":2,\r}')).toEqual({ a: 1, b: 2 });
  });

  it('stays linear on many unterminated block comments', () => {
    const start = Date.now();
    expect(() => parseLenientJson('{"a":1,' + '/*,'.repeat(100_000))).toThrow(SyntaxError);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('throws on text that is not JSON even after cleaning', () => {
    expect(() => parseLenientJson('{"a": nope,}')).toThrow(SyntaxError);
    expect(() => parseLenientJson('# just markdown')).toThrow(SyntaxError);
  });
});

describe('stripBom', () => {
  it('removes only a leading BOM', () => {
    expect(stripBom('\uFEFFabc')).toBe('abc');
    expect(stripBom('abc\uFEFF')).toBe('abc\uFEFF');
    expect(stripBom('')).toBe('');
  });
});
