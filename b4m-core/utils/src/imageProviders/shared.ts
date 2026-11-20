import type { ImageInputRole } from '@bike4mind/common';
import { ImageInputRejectedError, ImageModerationBlockedError } from '../imageGeneration/imageGenerationErrors';
import { downloadDeliveryUrl } from '../generationProviders/http';
import type { ProviderOutput, ProviderTerminalResult } from '../generationProviders/types';
import type { ImageInputs, ResolvedImageInput } from './types';

const MAX_CAUSE_DEPTH = 5;
// Well above a large PNG at the biggest size any image model renders; the cap only stops a runaway download.
export const MAX_IMAGE_OUTPUT_BYTES = 64 * 1024 * 1024;
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Settles with the promise `start` returns, or rejects as soon as `signal` aborts. The image services take no AbortSignal, so this is
 * how an adapter honours the step's lease. The abandoned call may still finish and bill, which is why an abort
 * must surface as a throw (an unknown outcome) and never as a classified failure.
 */
export const raceAbort = <T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  // `start` runs only after the check, so an already-aborted signal never reaches the provider.
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    start().then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
};

// The services rewrap SDK errors in prose; the SDK error (with its HTTP status) rides on `cause`. OpenAI SDK errors
// carry `status`; axios errors (BFL) carry it on `response`.
const httpStatusOf = (error: unknown): number | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const { status, response } = current as { status?: unknown; response?: { status?: unknown } };
    if (typeof status === 'number') return status;
    if (typeof response?.status === 'number') return response.status;
    current = current.cause;
  }
  return undefined;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Turns a thrown image-service error into a terminal result when the provider definitively generated nothing:
 * a policy block, or a 4xx answer. Returns null for everything else (a timeout, a reset, a 5xx), whose outcome is
 * unknown, so the caller rethrows and the job is not generated twice.
 */
export const classifyImageProviderError = (error: unknown): ProviderTerminalResult | null => {
  if (error instanceof ImageModerationBlockedError) {
    return { status: 'blocked', reason: error.message, raw: { requestId: error.requestId } };
  }
  // The service refused the input before calling the provider: nothing was made, and resending fails the same way.
  if (error instanceof ImageInputRejectedError) {
    return { status: 'failed', retryable: false, message: error.message, raw: error.logContext };
  }
  const status = httpStatusOf(error);
  if (status === undefined || status < 400 || status >= 500) return null;
  // 429: rate limited before anything was made. Any other 4xx is the same request failing the same way again.
  return { status: 'failed', retryable: status === 429, message: messageOf(error), raw: { status } };
};

export const inputsWithRole = (inputs: ImageInputs, role: ImageInputRole): ResolvedImageInput[] =>
  (inputs.images ?? []).filter(image => image.role === role);

export const toDataUrl = (image: Pick<ResolvedImageInput, 'bytes' | 'mimeType'>): string =>
  `data:${image.mimeType};base64,${image.bytes.toString('base64')}`;

/** The services return each image as a data URL; the job carries it as inline output. */
export const dataUrlToOutput = (dataUrl: string): ProviderOutput => {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) throw new Error('image provider returned an image that is not a base64 data URL');
  return { kind: 'inline', contentType: match[1], base64: match[2] };
};

export const decodeInlineOutput = (output: ProviderOutput): Buffer => {
  if (output.kind !== 'inline') throw new Error('expected inline image output');
  return Buffer.from(output.base64, 'base64');
};

/** Downloads a provider's delivery URL (an unauthenticated, short-lived link) under the image size cap. */
export const downloadImageOutput = async (output: ProviderOutput, signal: AbortSignal): Promise<Buffer> => {
  if (output.kind !== 'url') throw new Error('expected url image output');
  return downloadDeliveryUrl(output.url, MAX_IMAGE_OUTPUT_BYTES, signal);
};
