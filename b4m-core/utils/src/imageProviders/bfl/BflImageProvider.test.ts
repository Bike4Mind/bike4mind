import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  ImageModels,
  formatBflEditRegionsPrompt,
  type BflEditRegion,
  type StoredImageRequest,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { describeAsyncProviderConformance } from '../../generationProviders/conformance';
import {
  ProviderOutputUnavailableError,
  ProviderSubmitError,
  type GenerationProviderJobHandle,
  type ProviderContext,
} from '../../generationProviders/types';
import type { ImageInputs } from '../types';
import { BflImageProvider } from './BflImageProvider';

const BASE = 'https://api.bfl.ai/v1';
const POLLING_URL = 'https://api.us1.bfl.ai/v1/get_result?id=task-1';
const SAMPLE_URL = 'https://delivery-us1.bfl.ai/results/task-1/sample.png';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const request = (overrides: Partial<StoredImageRequest> = {}): StoredImageRequest => ({
  model: ImageModels.FLUX_PRO_1_1,
  mode: 'generate',
  prompt: 'a red bicycle',
  ...overrides,
});
const image = (role: 'edit_source' | 'mask' | 'reference', content: string) => ({
  role,
  bytes: Buffer.from(content),
  mimeType: 'image/png',
});
const b64 = (content: string) => Buffer.from(content).toString('base64');
const context = (overrides: Partial<ProviderContext> = {}): ProviderContext => ({
  apiKey: 'bfl-key',
  logger: new Logger({ metadata: { suite: 'BflImageProvider' } }),
  now: () => new Date(),
  signal: new AbortController().signal,
  ...overrides,
});
const handle = (data: Record<string, unknown> = { id: 'task-1', pollingUrl: POLLING_URL }) =>
  ({ provider: 'bfl', data }) as GenerationProviderJobHandle<'bfl'>;
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { detail: 'nope' } },
  });

const BAD_POLLING_URLS = [
  'https://attacker.example/poll',
  'http://api.bfl.ai/v1/get_result?id=task-1',
  'https://notbfl.ai/v1/get_result',
  'https://bfl.ai.evil.com/v1/get_result',
  'not a url',
];

let post: ReturnType<typeof vi.spyOn>;
let get: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn();

beforeEach(() => {
  post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'task-1', polling_url: POLLING_URL } });
  get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { status: 'Pending' } });
  fetchMock.mockReset().mockResolvedValue(new Response(PNG_BYTES, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  for (const level of ['log', 'debug', 'warn', 'error'] as const) {
    vi.spyOn(Logger.globalInstance, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const provider = new BflImageProvider();
const submittedBody = (): Record<string, unknown> => post.mock.calls[0][1] as Record<string, unknown>;
const submittedUrl = (): string => post.mock.calls[0][0] as string;

describe('BflImageProvider.submit: request mapping', () => {
  it('posts a FLUX 1.1 generation sized by the catalog default, with a reference as image_prompt', async () => {
    const inputs: ImageInputs = { images: [image('reference', 'ref')] };
    await provider.submit(request({ seed: 7, outputFormat: 'png' }), inputs, context());
    expect(submittedUrl()).toBe(`${BASE}/${ImageModels.FLUX_PRO_1_1}`);
    expect(submittedBody()).toMatchObject({
      prompt: 'a red bicycle',
      image_prompt: b64('ref'),
      width: 1280,
      height: 960,
      seed: 7,
      output_format: 'png',
    });
    expect(post.mock.calls[0][2]).toMatchObject({ headers: { 'x-key': 'bfl-key' } });
  });

  it('sizes a dimensions model from the requested size', async () => {
    await provider.submit(request({ model: ImageModels.FLUX_PRO, size: '1024x576' }), {}, context());
    expect(submittedBody()).toMatchObject({ width: 1024, height: 576 });
  });

  it('sizes Ultra by aspect ratio, not width and height', async () => {
    await provider.submit(request({ model: ImageModels.FLUX_PRO_ULTRA, aspectRatio: '21:9' }), {}, context());
    expect(submittedBody()).toMatchObject({ aspect_ratio: '21:9' });
    expect(submittedBody()).not.toHaveProperty('width');
  });

  it('sends FLUX.2 references as the input-image list', async () => {
    const inputs: ImageInputs = { images: [image('reference', 'a'), image('reference', 'b')] };
    await provider.submit(request({ model: ImageModels.FLUX_2_PRO }), inputs, context());
    expect(submittedBody()).toMatchObject({ input_image: b64('a'), input_image_2: b64('b') });
  });

  it('sends FLUX 3 references as one images array', async () => {
    const inputs: ImageInputs = { images: [image('reference', 'a'), image('reference', 'b')] };
    await provider.submit(request({ model: ImageModels.FLUX_3_IMAGE }), inputs, context());
    expect(submittedBody()).toMatchObject({ images: [b64('a'), b64('b')] });
  });

  it('edits with FLUX Fill: the edit_source as image and the mask as mask', async () => {
    const inputs: ImageInputs = { images: [image('edit_source', 'src'), image('mask', 'msk')] };
    await provider.submit(request({ model: ImageModels.FLUX_PRO_FILL, mode: 'edit' }), inputs, context());
    expect(submittedUrl()).toBe(`${BASE}/${ImageModels.FLUX_PRO_FILL}`);
    expect(submittedBody()).toMatchObject({ image: b64('src'), mask: b64('msk') });
  });

  it('sends no mask field when a Fill edit carries no mask', async () => {
    const inputs: ImageInputs = { images: [image('edit_source', 'src')] };
    await provider.submit(request({ model: ImageModels.FLUX_PRO_FILL, mode: 'edit' }), inputs, context());
    expect(submittedBody()).toMatchObject({ image: b64('src') });
    expect(submittedBody()).not.toHaveProperty('mask');
  });

  it.each([ImageModels.FLUX_KONTEXT_PRO, ImageModels.FLUX_KONTEXT_MAX])(
    'edits with %s: the edit_source as input_image, with the aspect ratio',
    async model => {
      const inputs: ImageInputs = { images: [image('edit_source', 'src')] };
      await provider.submit(request({ model, mode: 'edit', aspectRatio: '1:1' }), inputs, context());
      expect(submittedUrl()).toBe(`${BASE}/${model}`);
      expect(submittedBody()).toMatchObject({ input_image: b64('src'), aspect_ratio: '1:1' });
    }
  );

  it('edits with FLUX.2: the edit_source first, then references', async () => {
    const inputs: ImageInputs = { images: [image('reference', 'ref'), image('edit_source', 'src')] };
    await provider.submit(request({ model: ImageModels.FLUX_2_PRO, mode: 'edit' }), inputs, context());
    expect(submittedBody()).toMatchObject({ input_image: b64('src'), input_image_2: b64('ref') });
    expect(submittedBody()).not.toHaveProperty('mask');
  });

  it('lays FLUX 3 edit regions into the prompt and keeps the source in the images array', async () => {
    const editRegions: BflEditRegion[] = [{ prompt: 'make it blue', bbox: [0.1, 0.2, 0.8, 0.9] }];
    const inputs: ImageInputs = { images: [image('edit_source', 'src')] };
    await provider.submit(request({ model: ImageModels.FLUX_3_IMAGE, mode: 'edit', editRegions }), inputs, context());
    expect(submittedBody()).toMatchObject({
      prompt: formatBflEditRegionsPrompt('a red bicycle', editRegions),
      images: [b64('src')],
    });
    expect(submittedBody().prompt).not.toBe('a red bicycle');
  });

  it('sends a FLUX 3 edit without regions as the plain prompt', async () => {
    const inputs: ImageInputs = { images: [image('edit_source', 'src')] };
    await provider.submit(request({ model: ImageModels.FLUX_3_IMAGE, mode: 'edit' }), inputs, context());
    expect(submittedBody()).toMatchObject({ prompt: 'a red bicycle' });
  });

  it('passes the step signal to the submit call', async () => {
    const ctx = context();
    await provider.submit(request(), {}, ctx);
    expect(post.mock.calls[0][2]).toMatchObject({ signal: ctx.signal });
  });
});

describe('BflImageProvider.submit: outcomes', () => {
  it('returns a handle carrying the task id and polling URL', async () => {
    await expect(provider.submit(request(), {}, context())).resolves.toEqual(handle());
  });

  it('rejects an edit without an edit_source before calling BFL', async () => {
    const error = await provider
      .submit(request({ model: ImageModels.FLUX_KONTEXT_PRO, mode: 'edit' }), {}, context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, retryable: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('turns a 4xx into a definitive, non-retryable rejection', async () => {
    post.mockRejectedValue(httpError(422));
    const error = await provider.submit(request(), {}, context()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderSubmitError);
    expect(error).toMatchObject({ definitive: true, retryable: false });
  });

  it('turns a 429 into a definitive, retryable rejection', async () => {
    post.mockRejectedValue(httpError(429));
    const error = await provider.submit(request(), {}, context()).catch((e: unknown) => e);
    expect(error).toMatchObject({ definitive: true, retryable: true });
  });

  it.each([
    ['a 5xx', httpError(502)],
    ['a dropped connection', Object.assign(new Error('socket hang up'), { isAxiosError: true, code: 'ECONNRESET' })],
  ])('rethrows %s as an unknown outcome', async (_label, failure) => {
    post.mockRejectedValue(failure);
    const error = await provider.submit(request(), {}, context()).catch((e: unknown) => e);
    expect(error).toBe(failure);
  });

  it.each(BAD_POLLING_URLS)('treats the polling URL %s as an unknown outcome, never following it', async url => {
    post.mockResolvedValue({ data: { id: 'task-1', polling_url: url } });
    const error = await provider.submit(request(), {}, context()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderSubmitError);
    expect((error as Error).message).toMatch(/outside its own hosts/);
  });
});

describe('BflImageProvider: the API key stays off redirects', () => {
  it('submits and polls without following redirects', async () => {
    await provider.submit(request(), {}, context());
    await provider.poll(handle(), context());
    expect(post.mock.calls[0][2]).toMatchObject({ maxRedirects: 0 });
    expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
  });
});

describe('BflImageProvider.poll', () => {
  it.each(['Pending', 'Reasoning', 'Generating'])('reports %s as running', async status => {
    get.mockResolvedValue({ data: { status } });
    await expect(provider.poll(handle(), context())).resolves.toEqual({ status: 'running' });
    expect(get).toHaveBeenCalledWith(POLLING_URL, expect.objectContaining({ headers: expect.anything() }));
  });

  it.each(BAD_POLLING_URLS)('fails Ready with the delivery URL %s, without retry', async url => {
    get.mockResolvedValue({ data: { status: 'Ready', result: { sample: url } } });
    await expect(provider.poll(handle(), context())).resolves.toMatchObject({ status: 'failed', retryable: false });
  });

  it('fails a task BFL no longer knows, without retry', async () => {
    get.mockResolvedValue({ data: { status: 'Task not found' } });
    await expect(provider.poll(handle(), context())).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
      message: expect.stringContaining('task_not_found'),
    });
  });

  it('reports Ready as succeeded with the delivery URL', async () => {
    get.mockResolvedValue({ data: { status: 'Ready', result: { sample: SAMPLE_URL } } });
    await expect(provider.poll(handle(), context())).resolves.toEqual({
      status: 'succeeded',
      output: { kind: 'url', url: SAMPLE_URL, requiresAuth: false },
    });
  });

  it.each(['Request Moderated', 'Content Moderated'])('reports %s as blocked, not billed', async status => {
    get.mockResolvedValue({ data: { status } });
    const result = await provider.poll(handle(), context());
    expect(result).toMatchObject({ status: 'blocked', reason: status });
    expect(result).not.toHaveProperty('billed');
  });

  it('reports a task Error as a non-retryable failure', async () => {
    get.mockResolvedValue({ data: { status: 'Error', result: { error: 'bad input' } } });
    await expect(provider.poll(handle(), context())).resolves.toMatchObject({
      status: 'failed',
      retryable: false,
      message: expect.stringContaining('bad input'),
    });
  });

  it('reports a 4xx poll answer as failed', async () => {
    get.mockRejectedValue(httpError(404));
    await expect(provider.poll(handle(), context())).resolves.toMatchObject({ status: 'failed', retryable: false });
  });

  it('throws on a 5xx so the engine polls again', async () => {
    get.mockRejectedValue(httpError(503));
    await expect(provider.poll(handle(), context())).rejects.toThrow('503');
  });

  it.each(BAD_POLLING_URLS)('refuses a handle polling %s, without sending the key', async pollingUrl => {
    const result = await provider.poll(handle({ id: 'task-1', pollingUrl }), context());
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('BflImageProvider.fetchOutput', () => {
  it('downloads the delivery URL', async () => {
    const bytes = await provider.fetchOutput({ kind: 'url', url: SAMPLE_URL, requiresAuth: false }, context());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('refuses a non-https URL', async () => {
    await expect(
      provider.fetchOutput({ kind: 'url', url: 'http://delivery.bfl.ai/x.png', requiresAuth: false }, context())
    ).rejects.toThrow(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an expired link as unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('expired', { status: 403 }));
    await expect(
      provider.fetchOutput({ kind: 'url', url: SAMPLE_URL, requiresAuth: false }, context())
    ).rejects.toBeInstanceOf(ProviderOutputUnavailableError);
  });
});

describe('BflImageProvider models', () => {
  it('lists every FLUX model', () => {
    expect(provider.models).toEqual(
      expect.arrayContaining([
        ImageModels.FLUX_PRO,
        ImageModels.FLUX_PRO_FILL,
        ImageModels.FLUX_KONTEXT_MAX,
        ImageModels.FLUX_2_KLEIN_4B,
        ImageModels.FLUX_3_IMAGE_KLEIN,
      ])
    );
  });
});

let pollStatus: Record<string, unknown> = {};
let settleTo: Record<string, unknown> = {};
describeAsyncProviderConformance<StoredImageRequest, BflImageProvider>('BflImageProvider', {
  provider: () => new BflImageProvider(),
  beforeEach: () => {
    pollStatus = { status: 'Pending' };
    get.mockImplementation(async () => ({ data: pollStatus }));
  },
  scenario: name => {
    const terminal: Record<typeof name, Record<string, unknown>> = {
      succeeds: { status: 'Ready', result: { sample: SAMPLE_URL } },
      blocked: { status: 'Content Moderated' },
      fails: { status: 'Error', result: { error: 'render failed' } },
      rejects: {},
    };
    if (name === 'rejects') post.mockRejectedValue(httpError(400));
    // Running on the first poll, terminal once settled.
    settleTo = terminal[name];
    return request();
  },
  settle: () => {
    pollStatus = settleTo;
  },
});
