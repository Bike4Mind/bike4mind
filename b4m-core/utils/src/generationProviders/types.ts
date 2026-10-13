import type { GenerationProviderJobHandle, ProviderOutput } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

// Defined in common because the job payload persists them; re-exported so adapters import one module.
export type { GenerationProviderJobHandle, ProviderOutput };

/** A finished provider call. Expected provider outcomes are values, never exceptions. */
export type ProviderTerminalResult =
  | {
      status: 'succeeded';
      output: ProviderOutput;
      reportedDurationSeconds?: number;
      /** Lyrics the provider sang (its own or the user's), as plain lines; absent for instrumental output. */
      lyrics?: string;
    }
  /**
   * `billed`: set only when the provider is known to have charged for the blocked generation (it generated the
   * output, then withheld it). The job then settles the user's hold instead of releasing it; leave it unset when unsure.
   */
  | { status: 'blocked'; reason?: string; billed?: boolean; raw: unknown }
  | { status: 'failed'; retryable: boolean; message: string; raw: unknown };

export type ProviderPollResult =
  | { status: 'running'; /** Fraction complete, 0..1; the job handler clamps anything outside. */ progress?: number }
  | ProviderTerminalResult;

export type ResolvedInputs = { inputImage?: { bytes: Buffer; mimeType: string } };

export type ProviderContext = {
  apiKey: string;
  logger: Logger;
  now: () => Date;
  /** Aborts before the job step's lease runs out; pass it to every network call. An abort is a transport error. */
  signal: AbortSignal;
};

type ProviderBase<TProviderId extends string, TModelId extends string> = {
  readonly id: TProviderId;
  /** Must equal the catalog models whose `provider` is this id; the registry enforces it. */
  readonly models: readonly TModelId[];
  fetchOutput(output: ProviderOutput, ctx: ProviderContext): Promise<Buffer>;
};

/** Submit returns a handle the job engine polls (video). */
export type AsyncGenerationProvider<TProviderId extends string, TModelId extends string, TRequest> = ProviderBase<
  TProviderId,
  TModelId
> & {
  readonly mode: 'async';
  submit(
    request: TRequest,
    inputs: ResolvedInputs,
    ctx: ProviderContext
  ): Promise<GenerationProviderJobHandle<TProviderId>>;
  poll(handle: GenerationProviderJobHandle<TProviderId>, ctx: ProviderContext): Promise<ProviderPollResult>;
  cancel?(handle: GenerationProviderJobHandle<TProviderId>, ctx: ProviderContext): Promise<void>;
};

/**
 * One request returns the finished output (music), so every call may bill. Bound `generate` by `ctx.signal`: a
 * timeout or network error leaves the outcome unknown, so throw and the job handler must not call it again.
 * Return `failed` with `retryable: true` only when the provider definitively generated nothing (e.g. a 429).
 */
export type SyncGenerationProvider<TProviderId extends string, TModelId extends string, TRequest> = ProviderBase<
  TProviderId,
  TModelId
> & {
  readonly mode: 'sync';
  generate(request: TRequest, inputs: ResolvedInputs, ctx: ProviderContext): Promise<ProviderTerminalResult>;
};

// Every method is one bounded call: no method sleeps, loops or polls. The job engine owns waiting.
export type GenerationProvider<TProviderId extends string, TModelId extends string, TRequest> =
  AsyncGenerationProvider<TProviderId, TModelId, TRequest> | SyncGenerationProvider<TProviderId, TModelId, TRequest>;

/**
 * `definitive: true` means the provider answered and created nothing (a 4xx/429 response), so the
 * engine may retry the submit. Anything else (timeout, reset) leaves the outcome unknown and the
 * engine must not resubmit - see the orphaned-submit section of the video design spec.
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

export class ProviderOutputTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    bytes: number
  ) {
    super(`provider output exceeds ${maxBytes} bytes (got at least ${bytes})`);
    this.name = 'ProviderOutputTooLargeError';
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
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ProviderOutputTooLargeError(maxBytes, declared);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ProviderOutputTooLargeError(maxBytes, total);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
