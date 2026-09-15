import { describe, it, expect } from 'vitest';
import { parseTolerantJson } from './parseJson';

describe('parseTolerantJson', () => {
  it('parses clean JSON (round-trip)', () => {
    expect(parseTolerantJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n{"analysis":{"summary":"ok"}}\n```';
    expect(parseTolerantJson<{ analysis: { summary: string } }>(raw)).toEqual({ analysis: { summary: 'ok' } });
  });

  it('strips a bare ``` fenced block', () => {
    expect(parseTolerantJson('```\n{"x":true}\n```')).toEqual({ x: true });
  });

  it('extracts a JSON object wrapped in prose', () => {
    const raw = 'Sure! Here is the analysis:\n{"shouldContinue": false, "gaps": []}\nHope that helps.';
    expect(parseTolerantJson(raw)).toEqual({ shouldContinue: false, gaps: [] });
  });

  it('respects nested braces and braces inside strings', () => {
    const raw = 'prefix {"a": {"b": 1}, "s": "text with } brace"} suffix';
    expect(parseTolerantJson(raw)).toEqual({ a: { b: 1 }, s: 'text with } brace' });
  });

  it('returns null on unparseable input', () => {
    expect(parseTolerantJson('not json at all')).toBeNull();
    expect(parseTolerantJson('')).toBeNull();
    expect(parseTolerantJson('{ broken')).toBeNull();
  });
});
