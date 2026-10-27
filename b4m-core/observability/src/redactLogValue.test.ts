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

  it('redacts Map entries whose keys name a credential', () => {
    const creds = new Map([
      ['apiKey', 'sk-live-123'],
      ['password', 'hunter2'],
      ['baseURL', 'https://example.test'],
    ]);

    expect(redactLogValue({ creds })).toEqual({
      creds: { apiKey: '[REDACTED]', password: '[REDACTED]', baseURL: 'https://example.test' },
    });
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

  it('keeps a provider error code and request id while redacting credentials in its message', () => {
    const error = Object.assign(new Error('auth failed for Bearer sk-canary'), {
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      response: { headers: { 'x-request-id': 'req-1' } },
    });

    expect(redactLogValue({ error })).toEqual({
      error: {
        name: 'Error',
        message: 'auth failed for Bearer [REDACTED]',
        code: 'ERR_BAD_REQUEST',
        status: undefined,
        requestId: 'req-1',
      },
    });
    expect(json({ error })).not.toContain('sk-canary');
  });

  it('keeps the non-enumerable cause of an error, with its code', () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', address: '10.0.0.1' });
    expect(redactLogValue({ err: new TypeError('fetch failed', { cause }) })).toMatchObject({
      err: { message: 'fetch failed', cause: { message: 'connect ETIMEDOUT', code: 'ETIMEDOUT', address: '10.0.0.1' } },
    });
  });

  it('keeps the cause of a provider error and redacts secrets inside it', () => {
    const cause = new Error('proxy said Bearer sk-canary');
    const error = Object.assign(new Error('upstream failed', { cause }), { status: 502 });
    const redacted = redactLogValue({ error });
    expect(redacted).toMatchObject({ error: { status: 502, cause: { message: 'proxy said Bearer [REDACTED]' } } });
    expect(json({ error })).not.toContain('sk-canary');
  });

  it('walks a directly assigned (enumerable) cause once, so a wide cause is not truncated', () => {
    const err = new Error('outer');
    err.cause = { items: Array.from({ length: 1200 }, () => 'a') };
    const redacted = redactLogValue({ err }) as { err: { cause: { items: unknown[] } } };
    expect(redacted.err.cause.items).toHaveLength(1200);
    expect(redacted.err.cause.items.at(-1)).toBe('a');
  });

  it('omits cause when the error has none', () => {
    expect(redactLogValue({ err: new Error('plain') })).not.toHaveProperty('err.cause');
  });

  it('terminates on a cyclic cause chain and on one deeper than the depth cap', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(json({ err: a })).toContain('[Circular]');

    let deep = new Error('leaf');
    for (let i = 0; i < 50; i++) deep = new Error(`level-${i}`, { cause: deep });
    expect(json({ err: deep })).toContain('[Truncated]');
  });

  it('keeps a plain error message but drops its stack secrets', () => {
    const error = new Error('boom with Bearer abc123');
    expect(redactLogValue({ error })).toMatchObject({
      error: { name: 'Error', message: 'boom with Bearer [REDACTED]' },
    });
  });
});
