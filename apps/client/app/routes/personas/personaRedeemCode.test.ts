// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const post = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));

const { captureCodeFromFragment, getCapturedCode, redeemPersonaCode } = await import('./personaRedeemCode');

function rejection(status: number, data: unknown) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('failed', String(status), config, undefined, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}

describe('captureCodeFromFragment', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('takes the code from the fragment and clears it from the address', () => {
    window.history.replaceState(null, '', '/personas/redeem?x=1#code=abc');

    captureCodeFromFragment();

    expect(getCapturedCode()).toBe('abc');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
  });

  it('leaves the address alone when there is no code', async () => {
    window.history.replaceState(null, '', '/personas/redeem#other=1');

    vi.resetModules();
    const fresh = await import('./personaRedeemCode');
    fresh.captureCodeFromFragment();

    expect(fresh.getCapturedCode()).toBeUndefined();
    expect(window.location.hash).toBe('#other=1');
  });
});

describe('redeemPersonaCode', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('POSTs the code in the body for a browser session', async () => {
    post.mockResolvedValue({ status: 204 });

    await expect(redeemPersonaCode('abc')).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith('/api/personas/redeem', { code: 'abc', session: 'browser' });
  });

  it("surfaces the server's error message", async () => {
    post.mockRejectedValue(rejection(409, { error: 'This browser is already signed in.' }));

    await expect(redeemPersonaCode('abc')).resolves.toEqual({
      ok: false,
      message: 'This browser is already signed in.',
    });
  });

  it('falls back to a generic message when the server sent none', async () => {
    post.mockRejectedValue(new Error('network down'));

    const result = await redeemPersonaCode('abc');

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/could not be used/) });
  });

  it('falls back to a generic message when the server error is not a string', async () => {
    post.mockRejectedValue(rejection(400, { error: { code: 1 } }));

    await expect(redeemPersonaCode('abc')).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be used/),
    });
  });
});
