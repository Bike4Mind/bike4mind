/**
 * Tests for parseToolArgsLenient - recovers tool arguments from common
 * malformed-JSON patterns models emit.
 *
 * Provider-specific failures observed in the wild (and what we recover from):
 * - Anthropic / OpenAI: occasional trailing commas, especially before `]` after long edits
 * - Smaller / open-source models: code fences wrapping the JSON object
 * - Most providers when streaming gets interrupted: combination of both
 */

import { describe, it, expect, vi } from 'vitest';
import { parseToolArgsLenient } from './ReActAgent';

describe('parseToolArgsLenient', () => {
  it('parses valid JSON unchanged (happy path)', () => {
    const input = '{"path":"/tmp/x","mode":"r"}';
    expect(parseToolArgsLenient(input)).toEqual({ path: '/tmp/x', mode: 'r' });
  });

  it('recovers from trailing commas before closing brace', () => {
    const input = '{"a":1,"b":2,}';
    expect(parseToolArgsLenient(input)).toEqual({ a: 1, b: 2 });
  });

  it('recovers from trailing commas before closing bracket', () => {
    const input = '{"items":[1,2,3,]}';
    expect(parseToolArgsLenient(input)).toEqual({ items: [1, 2, 3] });
  });

  it('recovers from nested trailing commas', () => {
    const input = '{"a":{"b":[1,2,],"c":3,},}';
    expect(parseToolArgsLenient(input)).toEqual({ a: { b: [1, 2], c: 3 } });
  });

  it('recovers from a markdown code fence wrap', () => {
    const input = '```json\n{"path":"/tmp/x"}\n```';
    expect(parseToolArgsLenient(input)).toEqual({ path: '/tmp/x' });
  });

  it('recovers from a fence with no language tag', () => {
    const input = '```\n{"path":"/tmp/x"}\n```';
    expect(parseToolArgsLenient(input)).toEqual({ path: '/tmp/x' });
  });

  it('recovers from fence + trailing comma combined', () => {
    const input = '```json\n{"path":"/tmp/x","items":[1,2,],}\n```';
    expect(parseToolArgsLenient(input)).toEqual({ path: '/tmp/x', items: [1, 2] });
  });

  it('logs at debug level when recovery is used', () => {
    const debug = vi.fn();
    parseToolArgsLenient('{"a":1,}', { debug });
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/Recovered malformed tool args/));
  });

  it('does not log on the happy path', () => {
    const debug = vi.fn();
    parseToolArgsLenient('{"a":1}', { debug });
    expect(debug).not.toHaveBeenCalled();
  });

  it('rethrows the original parse error when recovery fails', () => {
    const input = '{"this is": not json at all';
    expect(() => parseToolArgsLenient(input)).toThrow(SyntaxError);
  });

  it('preserves commas inside strings (no false positives on valid JSON)', () => {
    // Strings containing comma+brace patterns are valid JSON and never reach the recovery path.
    const input = '{"k":"hello, world }"}';
    expect(parseToolArgsLenient(input)).toEqual({ k: 'hello, world }' });
  });
});
