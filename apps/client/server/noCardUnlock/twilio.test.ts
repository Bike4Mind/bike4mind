import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  TwilioApiError,
  checkVerificationCode,
  isTwilioUnavailable,
  lookupPhone,
  sendVerificationCode,
} from './twilio';

const credentials = { accountSid: 'AC1', authToken: 'tok', verifyServiceSid: 'VA1' };

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TwilioApiError', () => {
  it.each([
    [429, null, 'rateLimited'],
    [429, 60202, 'rateLimited'],
    [429, 60203, 'rateLimited'],
    [400, 20429, 'rateLimited'],
    [400, 60200, 'invalidNumber'],
    [400, 21211, 'invalidNumber'],
    [400, 21614, 'invalidNumber'],
    [403, 60410, 'blockedNumber'],
  ] as const)('maps status %s code %s to %s', (status, code, flag) => {
    const error = new TwilioApiError(status, code);
    for (const other of ['rateLimited', 'invalidNumber', 'blockedNumber'] as const) {
      expect(error[other]).toBe(other === flag);
    }
  });

  it('leaves an unknown code unmapped', () => {
    const error = new TwilioApiError(400, 12345);
    expect([error.rateLimited, error.invalidNumber, error.blockedNumber]).toEqual([false, false, false]);
  });
});

describe('isTwilioUnavailable', () => {
  it('is true for a 5xx and a request timeout only', () => {
    expect(isTwilioUnavailable(new TwilioApiError(503, null))).toBe(true);
    expect(isTwilioUnavailable(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isTwilioUnavailable(new TwilioApiError(400, 60200))).toBe(false);
    expect(isTwilioUnavailable(new Error('boom'))).toBe(false);
    expect(isTwilioUnavailable(new TypeError('fetch failed'))).toBe(true);
    expect(isTwilioUnavailable(new TypeError('x is not a function'))).toBe(false);
  });
});

describe('Twilio requests', () => {
  it('parses a Lookup response and encodes the number into the URL', async () => {
    respond(200, {
      valid: true,
      phone_number: '+447700900123',
      country_code: 'GB',
      line_type_intelligence: { type: 'mobile' },
    });
    expect(await lookupPhone(credentials, '+447700900123')).toEqual({
      valid: true,
      phoneNumber: '+447700900123',
      countryCode: 'GB',
      lineType: 'mobile',
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/PhoneNumbers/%2B447700900123?');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`
    );
  });

  it('reads missing or mistyped Lookup fields as null', async () => {
    respond(200, { valid: 'yes', line_type_intelligence: null });
    expect(await lookupPhone(credentials, '+447700900123')).toEqual({
      valid: false,
      phoneNumber: null,
      countryCode: null,
      lineType: null,
    });
  });

  it('throws a TwilioApiError carrying the status and the body code', async () => {
    respond(403, { code: 60410 });
    const error = await rejection(sendVerificationCode(credentials, '+447700900123'));
    expect(error).toBeInstanceOf(TwilioApiError);
    expect(error).toMatchObject({ status: 403, code: 60410 });
  });

  it('throws with a null code when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Gateway', { status: 502 }))
    );
    expect(await rejection(sendVerificationCode(credentials, '+447700900123'))).toMatchObject({
      status: 502,
      code: null,
    });
  });

  it('approves only an approved check, rejects an expired or exhausted one, and flags an outage', async () => {
    const check = () => checkVerificationCode(credentials, '+447700900123', '123456');
    respond(200, { status: 'approved' });
    expect(await check()).toBe('approved');
    respond(200, { status: 'pending' });
    expect(await check()).toBe('rejected');
    respond(404, { code: 20404 });
    expect(await check()).toBe('rejected');
    respond(429, { code: 60202 });
    expect(await check()).toBe('rejected');
    respond(500, {});
    expect(await check()).toBe('unavailable');
    respond(400, { code: 60200 });
    expect(await rejection(check())).toBeInstanceOf(TwilioApiError);
  });
});
