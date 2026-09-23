import { describe, it, expect } from 'vitest';
import { streamWithSizeLimit } from './streamWithSizeLimit';

/** A Response whose body streams `chunks` once via a real ReadableStreamDefaultReader shape. */
function bodyResponse(chunks: Uint8Array[] | null, onCancel?: () => void, onReleaseLock?: () => void): Response {
  if (chunks === null) {
    return { body: null } as unknown as Response;
  }
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => onCancel?.(),
        releaseLock: () => onReleaseLock?.(),
      }),
    },
  } as unknown as Response;
}

describe('streamWithSizeLimit', () => {
  it('rejects a response with no body instead of hanging on an undefined reader', async () => {
    await expect(streamWithSizeLimit(bodyResponse(null), 1024)).rejects.toThrow('No response body');
  });

  it('buffers a body that lands exactly at the cap', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const buffer = await streamWithSizeLimit(bodyResponse([bytes]), bytes.byteLength);

    expect(Buffer.from(buffer)).toEqual(Buffer.from(bytes));
  });

  it('cancels the reader and rejects once the body exceeds the cap', async () => {
    let cancelled = false;
    const oversized = [new Uint8Array(10)];
    const response = bodyResponse(oversized, () => {
      cancelled = true;
    });

    await expect(streamWithSizeLimit(response, 5)).rejects.toThrow('Image too large');
    expect(cancelled).toBe(true);
  });

  it('releases the reader lock on both the success and the over-cap path', async () => {
    let released = 0;
    const small = [new Uint8Array(2)];
    await streamWithSizeLimit(
      bodyResponse(small, undefined, () => released++),
      10
    );
    expect(released).toBe(1);

    released = 0;
    const oversized = [new Uint8Array(10)];
    await streamWithSizeLimit(
      bodyResponse(oversized, undefined, () => released++),
      5
    ).catch(() => undefined);
    expect(released).toBe(1);
  });
});
