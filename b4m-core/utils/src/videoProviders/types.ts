import type { ValidatedVideoRequest, VideoProviderId } from '@bike4mind/common';
import { MAX_VIDEO_OUTPUT_BYTES } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Opaque to everything but its adapter; persisted on the job as JSON.
export type ProviderJobHandle = { provider: VideoProviderId; data: Record<string, unknown> };

export type ProviderOutput =
  | { kind: 'inline'; base64: string; contentType: string }
  | { kind: 'url'; url: string; requiresAuth: boolean; contentType?: string };

// Expected provider outcomes are values, never exceptions; adapters throw only for transport or programmer errors.
export type ProviderPollResult =
  | { status: 'running'; progress?: number }
  | { status: 'succeeded'; output: ProviderOutput; reportedDurationSeconds?: number }
  | { status: 'blocked'; reason?: string; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };

export type ResolvedInputs = { inputImage?: { bytes: Buffer; mimeType: string } };

export type VideoProviderContext = { apiKey: string; logger: Logger; now: () => Date };

// Every method is one bounded call: no method sleeps, loops or polls. The job engine owns waiting.
export interface VideoProvider {
  readonly id: VideoProviderId;
  submit(request: ValidatedVideoRequest, inputs: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult>;
  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer>;
  cancel?(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void>;
}

/**
 * `definitive: true` means the provider answered and created nothing (a 4xx/429 response), so the
 * engine may retry the submit. Anything else (timeout, reset) leaves the outcome unknown and the
 * engine must not resubmit - see the orphaned-submit section of the design spec.
 */
export class ProviderSubmitError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    readonly raw?: unknown
  ) {
    super(message);
    this.name = 'ProviderSubmitError';
  }
}

export class VideoOutputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`video output exceeds ${MAX_VIDEO_OUTPUT_BYTES} bytes (got at least ${bytes})`);
    this.name = 'VideoOutputTooLargeError';
  }
}

// Shared by URL-delivering adapters so the size cap is enforced while streaming, not after buffering everything.
export async function readBoundedResponse(response: Response, maxBytes = MAX_VIDEO_OUTPUT_BYTES): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new VideoOutputTooLargeError(declared);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new VideoOutputTooLargeError(total);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
