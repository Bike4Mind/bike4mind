import { describe, it, expect } from 'vitest';
import { serializeError } from './serializeError';

describe('serializeError', () => {
  it('extracts message, name and stack from an Error instance', () => {
    const err = new Error('boom');
    const result = serializeError(err);
    expect(result).toMatchObject({ name: 'Error', message: 'boom' });
    expect((result as { stack?: string }).stack).toContain('boom');
  });

  it('includes a string code when present on the Error', () => {
    const err = Object.assign(new Error('nope'), { code: 'ECONNRESET' });
    expect(serializeError(err)).toMatchObject({ code: 'ECONNRESET' });
  });

  it('serializes a plain object to JSON instead of "[object Object]"', () => {
    const result = serializeError({ statusCode: 500, body: 'upstream failed' });
    expect(result).not.toBe('[object Object]');
    expect(result).toBe('{"statusCode":500,"body":"upstream failed"}');
  });

  it('falls back to a readable string for circular / unserializable objects', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const result = serializeError(circular);
    expect(result).not.toBe('[object Object]');
    expect(typeof result).toBe('string');
  });

  it('passes through string values unchanged', () => {
    expect(serializeError('plain failure')).toBe('plain failure');
  });

  it('stringifies primitive and nullish values', () => {
    expect(serializeError(42)).toBe('42');
    expect(serializeError(null)).toBe('null');
    expect(serializeError(undefined)).toBe('undefined');
  });
});
