import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import {
  invokeThumbnailRenderer,
  ThumbnailRendererError,
  THUMBNAIL_RENDERER_FUNCTION_ENV,
  THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS,
} from './invokeThumbnailRenderer';

const request = {
  documentUrl: 'https://bucket.example.test/drafts/thumbnail-renders/doc.html?X-Amz-Signature=abc',
  allowedScriptUrls: ['https://app.example.test/static/lib/chart.js'],
};
const send = vi.fn();
const client = { send } as unknown as Parameters<typeof invokeThumbnailRenderer>[1];
const answer = (payload: unknown, functionError?: string) =>
  send.mockResolvedValue({
    Payload: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    ...(functionError ? { FunctionError: functionError } : {}),
  });

beforeEach(() => {
  send.mockReset();
  vi.stubEnv(THUMBNAIL_RENDERER_FUNCTION_ENV, 'stage-PublishThumbnailRenderer');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('invokeThumbnailRenderer', () => {
  it('invokes the configured function synchronously with the request as its payload', async () => {
    answer({ status: 'rendered', imageBase64: 'UklGRg==' });
    await expect(invokeThumbnailRenderer(request, client)).resolves.toEqual({
      status: 'rendered',
      imageBase64: 'UklGRg==',
    });

    const [command, options] = send.mock.calls[0];
    expect(command).toBeInstanceOf(InvokeCommand);
    expect(command.input).toMatchObject({
      FunctionName: 'stage-PublishThumbnailRenderer',
      InvocationType: 'RequestResponse',
    });
    expect(JSON.parse(Buffer.from(command.input.Payload).toString('utf-8'))).toEqual(request);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS).toBeGreaterThan(75_000);
  });

  it('passes a timed-out answer through', async () => {
    answer({ status: 'timed-out' });
    await expect(invokeThumbnailRenderer(request, client)).resolves.toEqual({ status: 'timed-out' });
  });

  it('fails loudly when the function name is not configured', async () => {
    vi.stubEnv(THUMBNAIL_RENDERER_FUNCTION_ENV, '');
    await expect(invokeThumbnailRenderer(request, client)).rejects.toThrow(THUMBNAIL_RENDERER_FUNCTION_ENV);
    expect(send).not.toHaveBeenCalled();
  });

  it('turns a function error (including a Lambda timeout) into a short, single-line error', async () => {
    answer(
      { errorType: 'Sandbox.Timedout', errorMessage: `Task timed out\nafter 75.00 seconds ${'x'.repeat(1000)}` },
      'Unhandled'
    );
    const error = await invokeThumbnailRenderer(request, client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ThumbnailRendererError);
    const message = (error as Error).message;
    expect(message).toContain('Sandbox.Timedout: Task timed out after 75.00 seconds');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(400);
  });

  it('wraps an invoke that never got an answer', async () => {
    send.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    await expect(invokeThumbnailRenderer(request, client)).rejects.toBeInstanceOf(ThumbnailRendererError);
  });

  it.each([
    ['a non-JSON payload', 'not json'],
    ['an unknown status', { status: 'done', imageBase64: 'UklGRg==' }],
    ['a rendered answer with no image', { status: 'rendered' }],
    ['a rendered answer whose image is not base64', { status: 'rendered', imageBase64: '<svg/>' }],
    ['an empty payload', ''],
  ])('rejects %s', async (_label, payload) => {
    answer(payload);
    await expect(invokeThumbnailRenderer(request, client)).rejects.toBeInstanceOf(ThumbnailRendererError);
  });
});
