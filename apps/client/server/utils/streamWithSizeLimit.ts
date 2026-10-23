import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { isResponseTooLargeError } from '@bike4mind/server-utils/utils/ssrfProtection';

/**
 * Read a fetch Response body into a Buffer, aborting as soon as `maxBytes` is exceeded.
 *
 * Deliberately not `response.arrayBuffer()`: a hostile or broken upstream can omit Content-Length
 * and stream indefinitely, and a post-buffer size check would OOM the Lambda before it fired.
 *
 * Shared by the two routes that fetch caller-supplied image URLs - /api/external-image and
 * /api/search-image - so their size caps behave identically.
 */
export async function streamWithSizeLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new BadRequestError('No response body');

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read().catch((e: unknown) => {
        // safeFetch's own body cap can trip first when the caller passes the same maxBodyBytes.
        throw isResponseTooLargeError(e) ? new BadRequestError('Image too large') : e;
      });
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new BadRequestError('Image too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
