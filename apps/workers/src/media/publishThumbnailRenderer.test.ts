import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ renderHtmlThumbnail: vi.fn(), openLambdaChromiumContext: vi.fn() }));

vi.mock('./renderHtmlThumbnail', async importOriginal => ({
  ...(await importOriginal<typeof import('./renderHtmlThumbnail')>()),
  renderHtmlThumbnail: h.renderHtmlThumbnail,
}));
vi.mock('./launchLambdaChromium', () => ({ openLambdaChromiumContext: h.openLambdaChromiumContext }));

import { createThumbnailRendererHandler, fetchThumbnailDocument, handler } from './publishThumbnailRenderer';
import { ThumbnailRenderTimeoutError } from './renderHtmlThumbnail';
import { MAX_THUMBNAIL_DOCUMENT_BYTES, MAX_THUMBNAIL_IMAGE_BYTES } from './thumbnailRendererContract';

const DOCUMENT_URL = 'https://bucket.example.test/drafts/thumbnail-renders/doc.html?X-Amz-Signature=abc';
const SCRIPT_URL = 'https://app.example.test/static/lib/chart.js';
const IMAGE = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
const request = { documentUrl: DOCUMENT_URL, allowedScriptUrls: [SCRIPT_URL] };

const openContext = vi.fn();
const loadDocument = vi.fn();
const run = createThumbnailRendererHandler({ openContext, loadDocument });

beforeEach(() => {
  vi.clearAllMocks();
  loadDocument.mockResolvedValue('<h1>doc</h1>');
  h.renderHtmlThumbnail.mockResolvedValue(IMAGE);
});

describe('publish thumbnail renderer handler', () => {
  it('fetches the staged document, then renders it with the given allowlist and returns the image inline', async () => {
    const order: string[] = [];
    loadDocument.mockImplementation(async () => (order.push('load'), '<h1>doc</h1>'));
    h.renderHtmlThumbnail.mockImplementation(async () => (order.push('render'), IMAGE));

    await expect(run(request)).resolves.toEqual({ status: 'rendered', imageBase64: IMAGE.toString('base64') });
    expect(loadDocument).toHaveBeenCalledWith(DOCUMENT_URL);
    expect(h.renderHtmlThumbnail).toHaveBeenCalledWith({
      srcdoc: '<h1>doc</h1>',
      allowedScriptUrls: [SCRIPT_URL],
      openContext,
    });
    expect(order).toEqual(['load', 'render']);
  });

  it('answers timed-out when the page wedges the browser past its deadline', async () => {
    h.renderHtmlThumbnail.mockRejectedValue(new ThumbnailRenderTimeoutError('too slow'));
    await expect(run(request)).resolves.toEqual({ status: 'timed-out' });
  });

  it('throws anything else, so the invoke reports a function error', async () => {
    h.renderHtmlThumbnail.mockRejectedValue(new Error('Failed to launch the browser process'));
    await expect(run(request)).rejects.toThrow('Failed to launch');
  });

  it('refuses an image over the response limit', async () => {
    h.renderHtmlThumbnail.mockResolvedValue(Buffer.alloc(MAX_THUMBNAIL_IMAGE_BYTES + 1));
    await expect(run(request)).rejects.toThrow('over the');
  });

  it.each([
    ['a missing document URL', { allowedScriptUrls: [] }],
    ['a plain-http document URL', { ...request, documentUrl: 'http://bucket.example.test/doc.html' }],
    ['a file URL', { ...request, documentUrl: 'file:///etc/passwd' }],
    ['a non-URL script entry', { ...request, allowedScriptUrls: ['javascript:alert(1)'] }],
    ['no payload at all', undefined],
  ])('rejects %s before fetching or launching anything', async (_label, event) => {
    await expect(run(event)).rejects.toThrow();
    expect(loadDocument).not.toHaveBeenCalled();
    expect(h.renderHtmlThumbnail).not.toHaveBeenCalled();
  });

  it('is wired to the Lambda-packaged Chromium', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<h1>doc</h1>'));
    try {
      await handler(request);
      expect(h.renderHtmlThumbnail).toHaveBeenCalledWith(
        expect.objectContaining({ openContext: h.openLambdaChromiumContext })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('fetchThumbnailDocument', () => {
  it('GETs the link without following redirects and returns the body as text', async () => {
    // Non-ASCII on purpose (decoded as UTF-8), built from a code point to keep this file ASCII.
    const text = `<p>caf${String.fromCodePoint(0xe9)}</p>`;
    const fetchImpl = vi.fn(async () => new Response(text));
    await expect(fetchThumbnailDocument(DOCUMENT_URL, fetchImpl as unknown as typeof fetch)).resolves.toBe(text);
    expect(fetchImpl).toHaveBeenCalledWith(
      DOCUMENT_URL,
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })
    );
  });

  it('fails on a non-2xx answer (an expired or tampered link)', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }));
    await expect(fetchThumbnailDocument(DOCUMENT_URL, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'HTTP 403'
    );
  });

  it('refuses a declared length over the limit without reading the body', async () => {
    const arrayBuffer = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(MAX_THUMBNAIL_DOCUMENT_BYTES + 1) }),
      arrayBuffer,
    }));
    await expect(fetchThumbnailDocument(DOCUMENT_URL, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'over the limit'
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a body over the limit even when no length was declared', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(MAX_THUMBNAIL_DOCUMENT_BYTES + 1),
    }));
    await expect(fetchThumbnailDocument(DOCUMENT_URL, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'over the limit'
    );
  });
});
