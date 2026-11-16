import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageInputRejectedError, ImageModerationBlockedError } from '../imageGeneration/imageGenerationErrors';
import {
  classifyImageProviderError,
  dataUrlToOutput,
  decodeInlineOutput,
  downloadImageOutput,
  MAX_IMAGE_OUTPUT_BYTES,
  inputsWithRole,
  raceAbort,
  toDataUrl,
} from './shared';
import { ProviderOutputTooLargeError, ProviderOutputUnavailableError } from '../generationProviders/types';
import type { ImageInputs } from './types';

const withCause = (message: string, cause: unknown) => new Error(message, { cause });
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

describe('raceAbort', () => {
  it('resolves with the work result', async () => {
    await expect(raceAbort(() => Promise.resolve('done'), new AbortController().signal)).resolves.toBe('done');
  });

  it('rejects with the signal reason when aborted mid-flight', async () => {
    const controller = new AbortController();
    const reason = new Error('lease expired');
    const raced = raceAbort(() => new Promise<string>(() => undefined), controller.signal);
    controller.abort(reason);
    await expect(raced).rejects.toBe(reason);
  });

  it('throws immediately when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    const start = vi.fn(() => Promise.resolve('x'));
    expect(() => raceAbort(start, controller.signal)).toThrow('already');
    expect(start).not.toHaveBeenCalled();
  });

  it('propagates a rejection of the work', async () => {
    const failure = new Error('boom');
    await expect(raceAbort(() => Promise.reject(failure), new AbortController().signal)).rejects.toBe(failure);
  });
});

describe('classifyImageProviderError', () => {
  it('maps a moderation block to blocked with the request id', () => {
    const error = new ImageModerationBlockedError('refused', 'req_1');
    expect(classifyImageProviderError(error)).toEqual({
      status: 'blocked',
      reason: 'refused',
      raw: { requestId: 'req_1' },
    });
  });

  it('treats a 429 on the cause as a retryable failure', () => {
    const result = classifyImageProviderError(withCause('rate limited', httpError(429)));
    expect(result).toMatchObject({ status: 'failed', retryable: true, raw: { status: 429 } });
  });

  it('treats another 4xx found down the cause chain as a non-retryable failure', () => {
    const error = withCause('outer', withCause('middle', httpError(400)));
    expect(classifyImageProviderError(error)).toEqual({
      status: 'failed',
      retryable: false,
      message: 'outer',
      raw: { status: 400 },
    });
  });

  it('reads the status from the top-level error itself', () => {
    expect(classifyImageProviderError(httpError(404))).toMatchObject({ status: 'failed', retryable: false });
  });

  it('returns null for a 5xx, whose outcome is unknown', () => {
    expect(classifyImageProviderError(withCause('server', httpError(500)))).toBeNull();
  });

  it('returns null for an error with no status', () => {
    expect(classifyImageProviderError(new Error('timeout'))).toBeNull();
  });

  it('returns null for a non-error value', () => {
    expect(classifyImageProviderError('nope')).toBeNull();
  });
});

describe('image data helpers', () => {
  it('parses a base64 data URL into inline output', () => {
    expect(dataUrlToOutput('data:image/webp;base64,QUJD')).toEqual({
      kind: 'inline',
      contentType: 'image/webp',
      base64: 'QUJD',
    });
  });

  it('throws on a URL that is not a base64 data URL', () => {
    expect(() => dataUrlToOutput('https://example.com/a.png')).toThrow('not a base64 data URL');
  });

  it('round-trips bytes through toDataUrl, dataUrlToOutput and decodeInlineOutput', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const output = dataUrlToOutput(toDataUrl({ bytes, mimeType: 'image/png' }));
    expect(decodeInlineOutput(output).equals(bytes)).toBe(true);
  });

  it('refuses to decode output that is not inline', () => {
    expect(() => decodeInlineOutput({ kind: 'url', url: 'https://example.com/a.png' } as never)).toThrow(
      'expected inline image output'
    );
  });

  it('builds a data URL from bytes and mime type', () => {
    expect(toDataUrl({ bytes: Buffer.from('ABC'), mimeType: 'image/jpeg' })).toBe('data:image/jpeg;base64,QUJD');
  });
});

describe('inputsWithRole', () => {
  const image = (role: 'edit_source' | 'mask' | 'reference') => ({
    role,
    bytes: Buffer.from(role),
    mimeType: 'image/png',
  });

  it('returns only the images of the role, in order', () => {
    const inputs: ImageInputs = { images: [image('reference'), image('mask'), image('reference')] };
    expect(inputsWithRole(inputs, 'reference')).toHaveLength(2);
    expect(inputsWithRole(inputs, 'mask')).toEqual([inputs.images?.[1]]);
  });

  it('returns an empty list when there are no images', () => {
    expect(inputsWithRole({}, 'mask')).toEqual([]);
  });
});

describe('classifyImageProviderError input rejection', () => {
  it('maps an input the service refused to a non-retryable failure carrying its log context', () => {
    const error = new ImageInputRejectedError('mask must be PNG', {
      reason: 'unsupported_mask',
      mimeType: 'image/gif',
    });
    expect(classifyImageProviderError(error)).toEqual({
      status: 'failed',
      retryable: false,
      message: 'mask must be PNG',
      raw: { reason: 'unsupported_mask', mimeType: 'image/gif' },
    });
  });
});

describe('downloadImageOutput', () => {
  const fetchMock = vi.fn();
  const signal = new AbortController().signal;
  const output = (url: string) => ({ kind: 'url' as const, url, requiresAuth: false });
  const download = (url = 'https://cdn.example/a.png') => downloadImageOutput(output(url), signal);
  const redirect = (location?: string, status = 302) =>
    new Response(null, { status, headers: location ? { location } : {} });

  const stubFetch = () => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  };
  afterEach(() => vi.unstubAllGlobals());

  it('downloads the bytes', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response(Buffer.from([1, 2, 3]), { status: 200 }));
    expect((await download()).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('refuses a non-https url without fetching', async () => {
    stubFetch();
    await expect(download('http://cdn.example/a.png')).rejects.toThrow(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses inline output', async () => {
    await expect(
      downloadImageOutput({ kind: 'inline', base64: 'AA==', contentType: 'image/png' }, signal)
    ).rejects.toThrow(/url image output/);
  });

  it('follows one https redirect and refuses a further one', async () => {
    stubFetch();
    fetchMock
      .mockResolvedValueOnce(redirect('https://other.example/b.png'))
      .mockResolvedValueOnce(new Response(Buffer.from([9]), { status: 200 }));
    expect((await download()).equals(Buffer.from([9]))).toBe(true);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses a redirect to http, without following it', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(redirect('http://other.example/b.png'));
    await expect(download()).rejects.toThrow(/https/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect without a location', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(redirect());
    await expect(download()).rejects.toThrow(/location/);
  });

  it.each([403, 404, 410])('reports HTTP %s as an unavailable output', async status => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response('gone', { status }));
    await expect(download()).rejects.toBeInstanceOf(ProviderOutputUnavailableError);
  });

  it('treats a 503 as a plain failure the engine retries', async () => {
    stubFetch();
    fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
    const error = await download().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderOutputUnavailableError);
    expect((error as Error).message).toMatch(/503/);
  });

  it('refuses a body over the cap while streaming, with no content-length', async () => {
    stubFetch();
    const chunk = new Uint8Array(MAX_IMAGE_OUTPUT_BYTES / 2 + 1);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    await expect(download()).rejects.toBeInstanceOf(ProviderOutputTooLargeError);
  });
});
