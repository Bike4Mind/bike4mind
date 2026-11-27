import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIRequest, APIRequestContext } from '@playwright/test';
import { newWafRequestContext, scopeWafBypass } from '../../e2e/helpers/waf-bypass';

type Call = { method: string; url: unknown; options?: Record<string, unknown> };
type Reply = { status: number; location?: string };

// Stands in for APIRequestContext: records every call and answers fetch() from a scripted
// queue (200 once it runs dry). Members read `this` so an unbound method would throw.
function createFakeContext(replies: Reply[] = []) {
  const calls: Call[] = [];
  const disposed: string[] = [];
  const respond = (url: unknown) => {
    const reply = replies.shift() ?? { status: 200 };
    const base = typeof url === 'string' ? url : 'https://api.example.com/';
    const resolved = new URL(base, 'https://api.example.com/base/').href;
    return {
      status: () => reply.status,
      url: () => resolved,
      headers: () => (reply.location ? { location: reply.location } : {}),
      dispose: async () => {
        disposed.push(resolved);
      },
    };
  };
  const record = (method: string) =>
    function (this: unknown, url: unknown, options?: Record<string, unknown>) {
      if (this !== ctx) throw new Error(`${method} called with the wrong this`);
      calls.push({ method, url, options });
      return Promise.resolve(respond(url));
    };
  const ctx = {
    marker: 'fake',
    fetch: record('fetch'),
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    head: record('head'),
    dispose(this: unknown) {
      if (this !== ctx) throw new Error('dispose called with the wrong this');
      return Promise.resolve();
    },
    storageState(this: unknown) {
      if (this !== ctx) throw new Error('storageState called with the wrong this');
      return Promise.resolve({ cookies: [], origins: [] });
    },
  };
  return { ctx: ctx as unknown as APIRequestContext, calls, disposed };
}

describe('scopeWafBypass', () => {
  beforeEach(() => {
    vi.stubEnv('API_URL', 'https://api.example.com/base');
    vi.stubEnv('E2E_WAF_BYPASS_TOKEN', 'waf-token');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['/api/users/me', '', 'https://api.example.com/_next/static/x.js'])(
    'adds the header to a same-origin call: %j',
    async url => {
      const fake = createFakeContext();
      await scopeWafBypass(fake.ctx).get(url, { headers: { Authorization: 'Bearer t' } });
      expect(fake.calls).toEqual([
        {
          method: 'fetch',
          url,
          options: {
            method: 'GET',
            headers: { 'x-e2e-waf-bypass': 'waf-token', Authorization: 'Bearer t' },
            maxRedirects: 0,
          },
        },
      ]);
    }
  );

  it.each(['post', 'put', 'patch', 'delete', 'head'] as const)('maps %s to the matching method', async name => {
    const fake = createFakeContext();
    await scopeWafBypass(fake.ctx)[name]('/api/x', { data: { a: 1 } });
    expect(fake.calls[0].options).toMatchObject({ method: name.toUpperCase(), data: { a: 1 } });
    expect(fake.calls[0].options?.headers).toEqual({ 'x-e2e-waf-bypass': 'waf-token' });
  });

  it('keeps the method given to fetch and lets caller headers win', async () => {
    const fake = createFakeContext();
    await scopeWafBypass(fake.ctx).fetch('/api/x', { method: 'post', headers: { 'x-e2e-waf-bypass': 'caller' } });
    expect(fake.calls[0].options).toMatchObject({ method: 'POST', headers: { 'x-e2e-waf-bypass': 'caller' } });
  });

  it.each([
    'https://third-party.example/api/x',
    'https://api.example.com.evil.example/api/x',
    'http://api.example.com/api/x',
    'https://api.example.com:8443/api/x',
  ])('leaves an off-origin call untouched: %s', async url => {
    const fake = createFakeContext();
    const options = { headers: { Authorization: 'Bearer t' } };
    await scopeWafBypass(fake.ctx).post(url, options);
    expect(fake.calls).toEqual([{ method: 'post', url, options }]);
  });

  it('leaves a Request object untouched', async () => {
    const fake = createFakeContext();
    const request = { url: () => 'https://api.example.com/api/x' };
    await scopeWafBypass(fake.ctx).fetch(request as never);
    expect(fake.calls).toEqual([{ method: 'fetch', url: request, options: undefined }]);
  });

  it('follows a same-origin redirect with the header, dropping params and cookie', async () => {
    const fake = createFakeContext([{ status: 307, location: '/api/next' }]);
    const response = await scopeWafBypass(fake.ctx).get('https://api.example.com/api/start', {
      params: { q: '1' },
      headers: { Cookie: 'a=b', Authorization: 'Bearer t' },
    });
    expect(response.status()).toBe(200);
    expect(fake.disposed).toEqual(['https://api.example.com/api/start']);
    expect(fake.calls[1]).toEqual({
      method: 'fetch',
      url: 'https://api.example.com/api/next',
      options: {
        method: 'GET',
        params: undefined,
        headers: { 'x-e2e-waf-bypass': 'waf-token', Authorization: 'Bearer t' },
        maxRedirects: 0,
      },
    });
  });

  it('switches a POST to GET without a body on 303', async () => {
    const fake = createFakeContext([{ status: 303, location: '/api/done' }]);
    await scopeWafBypass(fake.ctx).post('/api/submit', {
      data: { a: 1 },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(fake.calls[1].options).toMatchObject({ method: 'GET', data: undefined });
    expect(fake.calls[1].options?.headers).toEqual({ 'x-e2e-waf-bypass': 'waf-token' });
  });

  it('returns a cross-origin redirect unfollowed, so the token never reaches that origin', async () => {
    const fake = createFakeContext([{ status: 302, location: 'https://elsewhere.example/landing' }]);
    const response = await scopeWafBypass(fake.ctx).get('/api/start');
    expect(response.status()).toBe(302);
    expect(fake.calls).toHaveLength(1);
  });

  it('honours maxRedirects: 0 by returning the redirect', async () => {
    const fake = createFakeContext([{ status: 302, location: '/api/next' }]);
    const response = await scopeWafBypass(fake.ctx).get('/api/start', { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(fake.calls).toHaveLength(1);
  });

  it('throws once the redirect budget is spent', async () => {
    const fake = createFakeContext([
      { status: 302, location: '/api/a' },
      { status: 302, location: '/api/b' },
    ]);
    await expect(scopeWafBypass(fake.ctx).get('/api/start', { maxRedirects: 1 })).rejects.toThrow(
      'Max redirect count exceeded'
    );
  });

  it('keeps `this` for members it does not wrap', async () => {
    const fake = createFakeContext();
    const scoped = scopeWafBypass(fake.ctx);
    await expect(scoped.storageState()).resolves.toEqual({ cookies: [], origins: [] });
    await expect(scoped.dispose()).resolves.toBeUndefined();
    expect((scoped as unknown as { marker: string }).marker).toBe('fake');
  });

  it.each(['', undefined])('returns the same context when the token is %j', token => {
    vi.stubEnv('E2E_WAF_BYPASS_TOKEN', token);
    const fake = createFakeContext();
    expect(scopeWafBypass(fake.ctx)).toBe(fake.ctx);
  });

  it('scopes contexts built by newWafRequestContext', async () => {
    const fake = createFakeContext();
    const newContext = vi.fn().mockResolvedValue(fake.ctx);
    const scoped = await newWafRequestContext({ newContext } as unknown as APIRequest, { baseURL: 'x' });
    expect(newContext).toHaveBeenCalledWith({ baseURL: 'x' });
    await scoped.get('/api/x');
    expect(fake.calls[0].options?.headers).toEqual({ 'x-e2e-waf-bypass': 'waf-token' });
  });

  it('applies the context-level maxRedirects to calls that set none', async () => {
    const fake = createFakeContext([
      { status: 302, location: '/api/a' },
      { status: 302, location: '/api/b' },
    ]);
    const newContext = vi.fn().mockResolvedValue(fake.ctx);
    const scoped = await newWafRequestContext({ newContext } as unknown as APIRequest, { maxRedirects: 1 });
    await expect(scoped.get('/api/start')).rejects.toThrow('Max redirect count exceeded');
  });
});
