import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RenderWorkspace } from './renderEnvironment';

const WORKSPACE: RenderWorkspace = {
  userDataDir: '/scratch/thumbnail-render-x/profile',
  tmpDir: '/scratch/thumbnail-render-x/tmp',
};

const h = vi.hoisted(() => ({
  renderHtmlThumbnail: vi.fn(),
  openLambdaChromiumContext: vi.fn(),
  lambdaEnvironmentOptions: undefined as unknown,
  lambdaEnvironmentRun: vi.fn(),
}));

vi.mock('./renderHtmlThumbnail', async importOriginal => ({
  ...(await importOriginal<typeof import('./renderHtmlThumbnail')>()),
  renderHtmlThumbnail: h.renderHtmlThumbnail,
}));
vi.mock('./launchLambdaChromium', () => ({ openLambdaChromiumContext: h.openLambdaChromiumContext }));
// The deployed wiring would empty this machine's /tmp; record what it asks for and run in place instead.
vi.mock('./renderEnvironment', async importOriginal => ({
  ...(await importOriginal<typeof import('./renderEnvironment')>()),
  createRenderEnvironment: (options: unknown) => {
    h.lambdaEnvironmentOptions = options;
    return { run: h.lambdaEnvironmentRun };
  },
}));

import {
  createThumbnailRendererHandler,
  fetchThumbnailDocument,
  handler,
  LAMBDA_SCRATCH_ROOT,
} from './publishThumbnailRenderer';
import { invokeThumbnailRenderer, THUMBNAIL_RENDERER_FUNCTION_ENV } from './invokeThumbnailRenderer';
import { procfsProcessTable, RenderEnvironmentError } from './renderEnvironment';
import { THUMBNAIL_CONTEXT_OPTIONS, ThumbnailRenderTimeoutError } from './renderHtmlThumbnail';
import { isWebp, MAX_THUMBNAIL_DOCUMENT_BYTES, MAX_THUMBNAIL_IMAGE_BYTES } from './thumbnailRendererContract';

const DOCUMENT_URL = 'https://bucket.example.test/drafts/thumbnail-renders/doc.html?X-Amz-Signature=abc';
const SCRIPT_URL = 'https://app.example.test/static/lib/chart.js';
const IMAGE = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');
const request = { documentUrl: DOCUMENT_URL, allowedScriptUrls: [SCRIPT_URL] };

const openContext = vi.fn();
const loadDocument = vi.fn();
const environment = { run: vi.fn() };
const run = createThumbnailRendererHandler({ openContext, loadDocument, environment });

beforeEach(() => {
  vi.clearAllMocks();
  loadDocument.mockResolvedValue('<h1>doc</h1>');
  h.renderHtmlThumbnail.mockResolvedValue(IMAGE);
  for (const fake of [environment.run, h.lambdaEnvironmentRun]) {
    fake.mockImplementation((render: (workspace: RenderWorkspace) => Promise<unknown>) => render(WORKSPACE));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
      openContext: expect.any(Function),
    });
    expect(order).toEqual(['load', 'render']);
  });

  it("does all of it inside one render environment, and opens the browser in that render's workspace", async () => {
    environment.run.mockImplementation(async (render: (workspace: RenderWorkspace) => Promise<unknown>) => {
      expect(loadDocument).not.toHaveBeenCalled();
      const result = await render(WORKSPACE);
      expect(h.renderHtmlThumbnail).toHaveBeenCalledTimes(1);
      return result;
    });

    await run(request, { deadline: 1_234_567 });
    expect(environment.run).toHaveBeenCalledTimes(1);
    expect(environment.run).toHaveBeenCalledWith(expect.any(Function), { deadline: 1_234_567 });
    const [{ openContext: bound }] = h.renderHtmlThumbnail.mock.calls[0];
    await bound(THUMBNAIL_CONTEXT_OPTIONS);
    expect(openContext).toHaveBeenCalledWith(THUMBNAIL_CONTEXT_OPTIONS, WORKSPACE);
  });

  it('fails without fetching or rendering anything when the environment refuses to start', async () => {
    environment.run.mockRejectedValue(new RenderEnvironmentError('render environment is not clean'));
    await expect(run(request)).rejects.toBeInstanceOf(RenderEnvironmentError);
    expect(loadDocument).not.toHaveBeenCalled();
    expect(h.renderHtmlThumbnail).not.toHaveBeenCalled();
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
    expect(environment.run).not.toHaveBeenCalled();
    expect(loadDocument).not.toHaveBeenCalled();
    expect(h.renderHtmlThumbnail).not.toHaveBeenCalled();
  });
});

describe('deployed publish thumbnail renderer', () => {
  const RUNTIME_API = '127.0.0.1:9001';
  const CONTEXT = { awsRequestId: 'request-1' };

  it('refuses to run anywhere but under the Lambda Runtime API', async () => {
    vi.stubEnv('AWS_LAMBDA_RUNTIME_API', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(handler(request, CONTEXT)).rejects.toThrow('only under the Lambda Runtime API');
    expect(h.lambdaEnvironmentRun).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('runs in a /tmp-rooted environment checked against /proc', () => {
    expect(LAMBDA_SCRATCH_ROOT).toBe('/tmp');
    expect(h.lambdaEnvironmentOptions).toEqual({ scratchRoot: '/tmp', processes: procfsProcessTable });
  });

  it('delivers a successful render the orchestrator accepts, then ends the runtime process', async () => {
    vi.stubEnv('AWS_LAMBDA_RUNTIME_API', RUNTIME_API);
    const order: string[] = [];
    let posted = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === DOCUMENT_URL) return new Response('<h1>doc</h1>');
      order.push(`post ${url}`);
      posted = String(init?.body);
      return new Response(null, { status: 202 });
    });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code: number) => void order.push(`exit ${code}`)) as never);

    await handler(request, { ...CONTEXT, getRemainingTimeInMillis: () => 70_000 });

    expect(h.lambdaEnvironmentRun).toHaveBeenCalledTimes(1);
    const [, runOptions] = h.lambdaEnvironmentRun.mock.calls[0];
    expect(runOptions.deadline).toBeGreaterThan(Date.now() + 60_000);
    expect(runOptions.deadline).toBeLessThan(Date.now() + 70_000);
    const [{ openContext: bound }] = h.renderHtmlThumbnail.mock.calls[0];
    await bound(THUMBNAIL_CONTEXT_OPTIONS);
    expect(h.openLambdaChromiumContext).toHaveBeenCalledWith(THUMBNAIL_CONTEXT_OPTIONS, WORKSPACE);
    expect(order).toEqual([`post http://${RUNTIME_API}/2018-06-01/runtime/invocation/request-1/response`, 'exit 0']);
    expect(exit).toHaveBeenCalledTimes(1);

    // The orchestrator receives exactly the posted payload.
    vi.stubEnv(THUMBNAIL_RENDERER_FUNCTION_ENV, 'stage-PublishThumbnailRenderer');
    const send = vi.fn(async () => ({ Payload: new TextEncoder().encode(posted) }));
    const client = { send } as unknown as Parameters<typeof invokeThumbnailRenderer>[1];
    const answer = await invokeThumbnailRenderer(request, client);
    expect(answer).toEqual({ status: 'rendered', imageBase64: IMAGE.toString('base64') });
    expect(answer.status === 'rendered' && isWebp(Buffer.from(answer.imageBase64, 'base64'))).toBe(true);
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
