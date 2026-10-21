import { describe, expect, it } from 'vitest';
import { redactLogValue } from './redactLogValue';

const json = (value: unknown) => JSON.stringify(redactLogValue(value));

describe('redactLogValue', () => {
  it('serializes an object with toJSON (an ObjectId, a mongoose document) instead of its internals', () => {
    const objectId = { buffer: { 0: 100, 1: 183 }, toJSON: () => 'hex-id' };
    expect(redactLogValue({ userId: objectId })).toEqual({ userId: 'hex-id' });
  });

  it('walks a Map and a Set', () => {
    expect(redactLogValue({ m: new Map([['a', 1]]) })).toEqual({ m: { a: 1 } });
    expect(redactLogValue({ s: new Set(['x']) })).toEqual({ s: ['x'] });
  });

  it('summarizes a Buffer rather than dumping its bytes', () => {
    expect(redactLogValue({ b: Buffer.alloc(4) })).toEqual({ b: '<Buffer 4 bytes>' });
  });

  it('bounds depth and node count', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(json(deep)).not.toContain('value');
    expect(json(deep)).toContain('[Truncated]');

    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    expect(json(wide)).toContain('[Truncated]');
  });

  it('keeps a plain error message but drops its stack secrets', () => {
    const error = new Error('boom with Bearer abc123');
    expect(redactLogValue({ error })).toMatchObject({
      error: { name: 'Error', message: 'boom with Bearer [REDACTED]' },
    });
  });
});
