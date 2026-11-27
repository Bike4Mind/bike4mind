import { describe, expect, it, vi } from 'vitest';
import { createStdioTransport } from './stdio';

const BASE = 'https://app.example.com';
const reply = (body: BodyInit | null, init: ResponseInit) => async () => new Response(body, init);
const jsonHeaders = { 'content-type': 'application/json' };

describe('createStdioTransport', () => {
  it('sends a contract operation through the SDK with the bearer key and maps json', async () => {
    const fetch = vi.fn(reply(JSON.stringify({ data: [], next_cursor: null }), { status: 200, headers: jsonHeaders }));
    const res = await createStdioTransport({ baseUrl: BASE, apiKey: 'b4m_live_x', fetch }).call('listWhatsNew', {
      query: { limit: 5 },
    });
    expect(res).toMatchObject({ status: 200, json: { data: [], next_cursor: null } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/whats-new?limit=5`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer b4m_live_x');
  });

  it('returns a non-2xx instead of throwing', async () => {
    const fetch = vi.fn(reply(JSON.stringify({ error: 'nope' }), { status: 401, headers: jsonHeaders }));
    const res = await createStdioTransport({ baseUrl: BASE, fetch }).call('listModels');
    expect(res).toMatchObject({ status: 401, json: { error: 'nope' } });
  });

  it('keeps a non-JSON error body as bytes on the SDK path', async () => {
    const fetch = vi.fn(reply('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const res = await createStdioTransport({ baseUrl: BASE, fetch }).call('listModels');
    expect(res.status).toBe(502);
    expect(new TextDecoder().decode(res.bytes)).toBe('<html>bad gateway</html>');
  });

  it('reports a 3xx as a redirect and does not follow it', async () => {
    const fetch = vi.fn(reply(null, { status: 302, headers: { location: 'https://cdn.example.com/x' } }));
    const res = await createStdioTransport({ baseUrl: BASE, fetch }).call('listWhatsNew');
    expect(res).toMatchObject({ status: 302, redirect: 'https://cdn.example.com/x' });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('maps a binary body to bytes', async () => {
    const fetch = vi.fn(reply(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } }));
    const res = await createStdioTransport({ baseUrl: BASE, fetch }).call('listWhatsNew');
    expect(res.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(res.json).toBeUndefined();
  });

  it('sends a route without a contract through the guarded builder', async () => {
    const fetch = vi.fn(reply(JSON.stringify({ status: 'pending' }), { status: 200, headers: jsonHeaders }));
    const t = createStdioTransport({ baseUrl: BASE, apiKey: 'k', fetch });
    const id = '0123456789abcdef01234567';
    await t.call('withdrawMcpConfirmation', { params: { id } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/mcp-confirmations/${id}`);
    expect(init.method).toBe('DELETE');
    await expect(t.call('getMcpConfirmation', { params: { id: '..' } })).rejects.toThrow(/Invalid path parameter/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
