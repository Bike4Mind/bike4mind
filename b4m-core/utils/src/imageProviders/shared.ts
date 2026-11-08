import type { ImageInputRole } from '@bike4mind/common';
import { ImageModerationBlockedError } from '../imageGeneration/imageGenerationErrors';
import type { ProviderOutput, ProviderTerminalResult } from '../generationProviders/types';
import type { ImageInputs, ResolvedImageInput } from './types';

const MAX_CAUSE_DEPTH = 5;
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/s;

/**
 * Settles with `work`, or rejects as soon as `signal` aborts. The image services take no AbortSignal, so this is
 * how an adapter honours the step's lease. The abandoned call may still finish and bill, which is why an abort
 * must surface as a throw (an unknown outcome) and never as a classified failure.
 */
export const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
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

// The services rewrap SDK errors in prose; the SDK error (with its HTTP status) rides on `cause`.
const httpStatusOf = (error: unknown): number | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const status: unknown = (current as { status?: unknown }).status;
    if (typeof status === 'number') return status;
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
  if (output.kind !== 'inline') throw new Error('image providers only produce inline output');
  return Buffer.from(output.base64, 'base64');
};
