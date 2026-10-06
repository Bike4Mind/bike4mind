import type {
  ProviderJobHandle,
  ProviderOutput,
  ValidatedVideoRequest,
  VideoModelId,
  VideoProviderId,
} from '@bike4mind/common';
import { MAX_VIDEO_OUTPUT_BYTES } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Defined in common because the job payload persists them; re-exported so adapters import one module.
export type { ProviderJobHandle, ProviderOutput };

// Expected provider outcomes are values, never exceptions; adapters throw only for transport or programmer errors.
export type ProviderPollResult =
  | { status: 'running'; /** Fraction complete, 0..1; the job handler clamps anything outside. */ progress?: number }
  | { status: 'succeeded'; output: ProviderOutput; reportedDurationSeconds?: number }
  /**
   * `billed`: set only when the provider is known to have charged for the blocked generation (it generated the clip,
   * then withheld it). The job then settles the user's hold instead of releasing it; leave it unset when unsure.
   */
  | { status: 'blocked'; reason?: string; billed?: boolean; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };

export type ResolvedInputs = { inputImage?: { bytes: Buffer; mimeType: string } };

export type VideoProviderContext = {
  apiKey: string;
  logger: Logger;
  now: () => Date;
  /** Aborts before the job step's lease runs out; pass it to every network call. An abort is a transport error. */
  signal: AbortSignal;
};

// Every method is one bounded call: no method sleeps, loops or polls. The job engine owns waiting.
export interface VideoProvider {
  readonly id: VideoProviderId;
  /** Must equal the catalog models whose `provider` is this id; the registry enforces it. */
  readonly models: readonly VideoModelId[];
  submit(request: ValidatedVideoRequest, inputs: ResolvedInputs, ctx: VideoProviderContext): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<ProviderPollResult>;
  fetchOutput(output: ProviderOutput, ctx: VideoProviderContext): Promise<Buffer>;
  cancel?(handle: ProviderJobHandle, ctx: VideoProviderContext): Promise<void>;
}

/**
 * `definitive: true` means the provider answered and created nothing (a 4xx/429 response), so the
 * engine may retry the submit. Anything else (timeout, reset) leaves the outcome unknown and the
 * engine must not resubmit - see the orphaned-submit section of the design spec.
 * `retryable` only matters when definitive: false marks a deterministic rejection (invalid parameter,
 * auth) that the same request would hit again, so the job fails now instead of resubmitting.
 */
export class ProviderSubmitError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
    readonly raw?: unknown,
    readonly retryable: boolean = definitive
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

/** The provider no longer has the output (expired or purged); retrying the download cannot succeed. */
export class ProviderOutputUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`provider output is no longer available (HTTP ${status})`);
    this.name = 'ProviderOutputUnavailableError';
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
