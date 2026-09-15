import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { redactErrorForLog } from './redactErrorForLog';

// A fake, clearly-not-real key - never commit the actual leaked production key.
const SECRET = 'TEST-BFL-KEY-00000000-1111-2222-3333-444444444444';

/** A shape that passes axios.isAxiosError (checks the isAxiosError flag at runtime). */
const makeAxiosError = () =>
  Object.assign(new Error('Request failed with status code 402'), {
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    config: {
      url: 'https://api.bfl.ai/v1/flux-pro-1.1',
      method: 'post',
      headers: { 'x-key': SECRET, 'Content-Type': 'application/json' },
    },
    response: {
      status: 402,
      data: { detail: 'Insufficient credits' },
      headers: { 'x-served-by': 'bfl' },
    },
  });

describe('redactErrorForLog', () => {
  it('sanity: the RAW AxiosError would leak the x-key when logged (#9230)', () => {
    const raw = makeAxiosError();
    // This is what `console.error('...', error)` effectively serializes today.
    expect(JSON.stringify(raw)).toContain(SECRET);
  });

  it('never includes the x-key API secret from request headers', () => {
    const redacted = redactErrorForLog(makeAxiosError());
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });

  it('does not include request OR response headers at all', () => {
    const redacted = redactErrorForLog(makeAxiosError()) as Record<string, unknown>;
    expect(redacted).not.toHaveProperty('headers');
    expect(JSON.stringify(redacted)).not.toContain('x-served-by');
  });

  it('preserves the useful debugging fields', () => {
    const redacted = redactErrorForLog(makeAxiosError()) as Record<string, unknown>;
    expect(redacted.message).toBe('Request failed with status code 402');
    expect(redacted.code).toBe('ERR_BAD_REQUEST');
    expect(redacted.status).toBe(402);
    expect(redacted.data).toEqual({ detail: 'Insufficient credits' });
    expect(redacted.endpoint).toBe('https://api.bfl.ai/v1/flux-pro-1.1');
    expect(redacted.method).toBe('post');
  });

  it('handles a plain Error without leaking and keeps the message', () => {
    const redacted = redactErrorForLog(new Error('boom')) as Record<string, unknown>;
    expect(redacted.message).toBe('boom');
    expect(redacted).not.toHaveProperty('config');
  });

  it('passes through non-error values unchanged', () => {
    expect(redactErrorForLog('plain string')).toBe('plain string');
    expect(redactErrorForLog(undefined)).toBeUndefined();
  });

  it('is recognized as an axios error by axios itself (guards the test fixture)', () => {
    expect(axios.isAxiosError(makeAxiosError())).toBe(true);
  });
});
