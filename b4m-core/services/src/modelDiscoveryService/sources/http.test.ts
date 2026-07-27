import { describe, expect, it } from 'vitest';
import { makeContext, stubFetch } from './__fixtures__/testSupport';
import { fetchText, MAX_RESPONSE_BYTES, redactUrl } from './http';

describe('redactUrl', () => {
  it('strips basic-auth credentials and the query string', () => {
    expect(redactUrl('https://user:pa55@ollama.internal:11434/api/tags?token=secret')).toBe(
      'https://ollama.internal:11434/api/tags'
    );
  });

  it('leaves an ordinary url alone apart from its query', () => {
    expect(redactUrl('https://api.x.ai/v1/models')).toBe('https://api.x.ai/v1/models');
  });

  it('strips the userinfo of a url it cannot parse', () => {
    const redacted = redactUrl('http://user:pa55@/api/tags?key=secret');

    expect(redacted).not.toContain('pa55');
    expect(redacted).not.toContain('secret');
  });
});

describe('fetchText', () => {
  it('never puts a credential from the base url into an error string', async () => {
    const url = 'https://user:pa55@ollama.internal:11434/api/tags';
    const restore = stubFetch({ status: 503, body: {} });
    try {
      const result = await fetchText({ url }, makeContext());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('https://ollama.internal:11434/api/tags responded 503');
        expect(result.error).not.toContain('pa55');
      }
    } finally {
      restore();
    }
  });

  it('keeps the credential out of a transport error too', async () => {
    const url = 'https://user:pa55@ollama.internal:11434/api/tags';
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const result = await fetchText({ url }, makeContext());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('https://ollama.internal:11434/api/tags failed: ECONNREFUSED');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reads a body inside the cap unchanged, multi-byte characters included', async () => {
    // Escaped rather than literal to keep the source ASCII; the bytes on the
    // wire are what the streaming decode has to reassemble.
    const body = '{"name":"caf\u00e9 \u2764\ufe0f"}';
    const restore = stubFetch({ raw: body });
    try {
      const result = await fetchText({ url: 'https://feeds.example/models.json' }, makeContext());

      expect(result.ok && !result.notModified && result.text).toBe(body);
    } finally {
      restore();
    }
  });

  it('refuses a body past the cap on the declared length alone', async () => {
    const restore = stubFetch({
      body: {},
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    });
    try {
      const result = await fetchText({ url: 'https://feeds.example/models.json' }, makeContext());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('response cap');
    } finally {
      restore();
    }
  });

  it('refuses a body that only exceeds the cap once it is streamed', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        // A chunk past the cap, sent without a content-length: the declared
        // length is the fast path, never the guarantee.
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
        controller.close();
      },
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await fetchText({ url: 'https://feeds.example/models.json' }, makeContext());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(`${MAX_RESPONSE_BYTES}-byte response cap`);
    } finally {
      globalThis.fetch = original;
    }
  });
});
