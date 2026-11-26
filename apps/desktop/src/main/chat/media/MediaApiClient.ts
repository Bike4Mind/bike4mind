import type { Readable } from 'node:stream';
import { z } from 'zod';
import axios, { isAxiosError, type AxiosError } from 'axios';
import { SessionChangedError, type AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  CreateFileUploadResponseSchema,
  CreateImageJobResponseSchema,
  FileResponseSchema,
  ImageJobSchema,
  ListImageJobsResponseSchema,
  ListVideoGenerationsResponseSchema,
  MusicGenerationSchema,
  VideoGenerationSchema,
  ttsBase64ResponseSchema,
  type CreateFileUploadResponse,
  type CreateImageJobBody,
  type CreateVideoGenerationBody,
  type FileResponse,
  type PublicImageJob,
  type VideoGeneration,
  type CreateMusicGenerationBody,
  type MusicGeneration,
  type PublicMusicModel,
  type SoundEffectsRequest,
  type TTSRequest,
  type TtsBase64Response,
  type CompletionRunAttribution,
} from '@bike4mind/common';
import type { BillingPayer } from '@shared/account';
import type { ChatToolNotice } from '@shared/chat';
import { currentBillingPayer } from '../../account/billingPayer';
import {
  isRunBudgetExhausted,
  isRunNotFound,
  RunBudgetExhaustedError,
  RunNotFoundError,
  withRunFallback,
} from '../completions';
import { parseMusicModels } from './musicModels';

/**
 * The orchestration run a turn's paid calls are charged to. Read at call time: the turn drops a
 * run the server refused, and a call made after that must not send it again.
 */
export interface MediaRun {
  current: () => CompletionRunAttribution | undefined;
  /** A budgeted run is never resent unattributed: that would spend outside the cap. */
  budgeted: boolean;
  /** The payer the run was minted for. Every call this client makes for the run bills it, not the selection. */
  payer?: BillingPayer;
  /** Runs when the server no longer knows the run, before any resend. See withRunFallback. */
  onRejected: () => Promise<void>;
}

type RunField = { run?: CompletionRunAttribution };

/**
 * A generation failure worth saying something specific about.
 *
 * `notice` is set for the two outcomes that are not really errors in the usual sense: running
 * out of credits (nothing was charged and nothing was produced) and, on the success path, a
 * provider standing in for the one that was asked for. See ChatToolNotice.
 */
export class MediaToolError extends Error {
  code?: string;
  requestNotStarted?: boolean;
  /** The HTTP status behind it, when there was one; the video poller backs off differently per status. */
  status?: number;
  /** How long the server asked this caller to wait, in ms, when a 429 carried a Retry-After. */
  retryAfterMs?: number;

  constructor(
    message: string,
    readonly notice?: ChatToolNotice
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

export interface FetchedBytes {
  bytes: Buffer;
  contentType: string;
}

/**
 * Per-request timeouts, because the app's shared client is configured for ordinary API calls
 * and these are not ordinary API calls.
 *
 * The audio routes are the slow ones - they synthesize inline and return the bytes, so the whole
 * provider round trip happens inside the request.
 */
const TIMEOUT_MS = {
  /** Queue submit: the route validates inputs and reserves credits before it answers. */
  submit: 90_000,
  /** Synthesis happens inline on these, and a long track takes a while to render. */
  audio: 180_000,
  /** A few megabytes over whatever link the deployment is on. */
  download: 60_000,
  /** A clip can run to tens of megabytes; this bounds a stalled transfer, not a slow one. */
  video: 300_000,
};

/**
 * The payer each Idempotency-Key was first sent with. The server scopes a key to the billed account,
 * so a retry that re-read a since-switched payer would start a second, differently billed job.
 * Module-wide because callers build a fresh client per submit; bounded, oldest evicted first.
 */
const PAYER_BY_IDEMPOTENCY_KEY = new Map<string, BillingPayer>();
const PAYER_BY_IDEMPOTENCY_KEY_LIMIT = 500;

/**
 * The b4m generation endpoints this client calls, over the app's authenticated session.
 *
 * Shaped after packages/cli/src/mcp/b4mApiClient.ts: one typed method per route, with the
 * transport quirks (arraybuffer bodies, a JSON error body arriving as bytes) handled here so
 * the tools above it deal in outcomes. Not merged with that class because the CLI's is built on
 * the CLI's own ApiClient and config store; this one takes the desktop app's AuthenticatedApiClient.
 */
export class MediaApiClient {
  /** `getPayer` is read per submit (see `payer()`), so a switch applies to this client's next call. */
  constructor(
    private readonly api: AuthenticatedApiClient,
    private readonly run?: MediaRun,
    private readonly getPayer: () => BillingPayer | Promise<BillingPayer> = currentBillingPayer
  ) {}

  /**
   * Send a paid request with the turn's run, tagged as a tool call so the run's usage tells it
   * apart from the turn's completions. The server claims the call's whole cost against the run
   * before charging, and refuses it with 422 run_budget_exhausted when it does not fit.
   */
  private withRun<T>(send: (field: RunField) => Promise<T>): Promise<T> {
    const current = this.run?.current();
    return withRunFallback(
      current && { ...current, purpose: 'tool' },
      async attribution => {
        try {
          return await send(attribution ? { run: attribution } : {});
        } catch (error) {
          throw toRunRefusal(error) ?? error;
        }
      },
      async () => this.run?.onRejected(),
      { budgeted: this.run?.budgeted }
    );
  }

  /**
   * Start image jobs: `count` of them sharing a group id, one image each. Returns as soon as they are queued; the
   * images render server-side. `idempotencyKey` makes a retried submit return the same jobs, not a second bill.
   */
  async createImageJobGroup(
    body: CreateImageJobBody,
    idempotencyKey: string
  ): Promise<{ group_id: string; data: PublicImageJob[] }> {
    try {
      const payer = await this.payer('/api/v1/image-jobs', idempotencyKey);
      const response = await this.withRun(run =>
        this.api.post<unknown>(
          '/api/v1/image-jobs',
          { ...body, ...payer, ...run },
          { timeout: TIMEOUT_MS.submit, headers: { 'Idempotency-Key': idempotencyKey } }
        )
      );
      return CreateImageJobResponseSchema.parse(response);
    } catch (error) {
      throw toPaidCallError(error, 'Image generation');
    }
  }

  /** createImageJobGroup for a caller that only follows the jobs. */
  async createImageJob(body: CreateImageJobBody, idempotencyKey: string): Promise<PublicImageJob[]> {
    return (await this.createImageJobGroup(body, idempotencyKey)).data;
  }

  async getImageJob(jobId: string, signal?: AbortSignal): Promise<PublicImageJob> {
    try {
      const response = await this.api.get<unknown>(`/api/v1/image-jobs/${encodeURIComponent(jobId)}`, {
        timeout: TIMEOUT_MS.download,
        signal,
      });
      return ImageJobSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Reading the image job');
    }
  }

  /** One page of the caller's own finished image jobs, newest first (the Library place). */
  async listImageJobs(query: { limit: number; cursor?: string }): Promise<z.infer<typeof ListImageJobsResponseSchema>> {
    try {
      const response = await this.api.get<unknown>('/api/v1/image-jobs', {
        params: { limit: query.limit, state: 'succeeded', ...(query.cursor ? { cursor: query.cursor } : {}) },
        timeout: TIMEOUT_MS.download,
      });
      return ListImageJobsResponseSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Listing your images');
    }
  }

  /** One page of the caller's own finished video generations, newest first (the Library place). */
  async listVideoGenerations(query: {
    limit: number;
    cursor?: string;
  }): Promise<z.infer<typeof ListVideoGenerationsResponseSchema>> {
    try {
      const response = await this.api.get<unknown>('/api/v1/video-generations', {
        params: { limit: query.limit, state: 'succeeded', ...(query.cursor ? { cursor: query.cursor } : {}) },
        timeout: TIMEOUT_MS.download,
      });
      return ListVideoGenerationsResponseSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Listing your videos');
    }
  }

  async cancelImageJob(jobId: string): Promise<PublicImageJob> {
    try {
      const response = await this.api.post<unknown>(
        `/api/v1/image-jobs/${encodeURIComponent(jobId)}/cancel`,
        {},
        { timeout: TIMEOUT_MS.download }
      );
      return ImageJobSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Cancelling the image');
    }
  }

  /**
   * Fetch a generated file an image job pointed at.
   *
   * A relative URL is this deployment's own local file proxy (self-host and personal dev stages
   * set NEXT_PUBLIC_CDN_URL to `/api/app-files/serve`), so it goes through the authenticated
   * client. An absolute one is a CDN that serves it unauthenticated, and is fetched with a bare
   * axios instance so the access token is never sent to an origin that is not the backend.
   */
  async fetchGenerated(url: string, action = 'Downloading the generated image'): Promise<FetchedBytes> {
    const absolute = /^https?:\/\//i.test(url);
    try {
      const config = { responseType: 'arraybuffer' as const, timeout: TIMEOUT_MS.download };
      const response = absolute
        ? await axios.get<ArrayBuffer>(url, config)
        : await this.api.getAxiosInstance().get<ArrayBuffer>(url, config);
      const header = response.headers['content-type'];
      return {
        bytes: Buffer.from(response.data),
        contentType: typeof header === 'string' ? header : '',
      };
    } catch (error) {
      throw toMediaError(error, action);
    }
  }

  /**
   * Start a video job. Returns as soon as it is queued; the clip renders server-side.
   * `idempotencyKey` makes a retried submit of the same call return the same job, not a second bill.
   */
  async createVideoGeneration(body: CreateVideoGenerationBody, idempotencyKey: string): Promise<VideoGeneration> {
    try {
      const payer = await this.payer('/api/v1/video-generations', idempotencyKey);
      const response = await this.withRun(run =>
        this.api.post<unknown>(
          '/api/v1/video-generations',
          { ...body, ...payer, ...run },
          { timeout: TIMEOUT_MS.submit, headers: { 'Idempotency-Key': idempotencyKey } }
        )
      );
      return VideoGenerationSchema.parse(response);
    } catch (error) {
      throw toPaidCallError(error, 'Video generation');
    }
  }

  async getVideoGeneration(jobId: string, signal?: AbortSignal): Promise<VideoGeneration> {
    try {
      const response = await this.api.get<unknown>(`/api/v1/video-generations/${encodeURIComponent(jobId)}`, {
        timeout: TIMEOUT_MS.download,
        signal,
      });
      return VideoGenerationSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Reading the video job');
    }
  }

  async cancelVideoGeneration(jobId: string): Promise<VideoGeneration> {
    try {
      const response = await this.api.post<unknown>(
        `/api/v1/video-generations/${encodeURIComponent(jobId)}/cancel`,
        {},
        { timeout: TIMEOUT_MS.download }
      );
      return VideoGenerationSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Cancelling the video');
    }
  }

  /**
   * Upload an image as a file of the user's, for image-to-video: register it, then PUT the bytes
   * to the URL that answers. The PUT carries no app credential - the URL is the capability - and
   * a self-hosted server answers with a same-origin path, resolved here against the backend.
   */
  async uploadFile(fileName: string, mimeType: string, bytes: Buffer): Promise<CreateFileUploadResponse> {
    let upload: CreateFileUploadResponse;
    try {
      upload = CreateFileUploadResponseSchema.parse(
        await this.api.post<unknown>(
          '/api/v1/files',
          { file_name: fileName, mime_type: mimeType, file_size: bytes.length },
          { timeout: TIMEOUT_MS.download }
        )
      );
    } catch (error) {
      throw toMediaError(error, 'Uploading the input image');
    }
    try {
      const target = new URL(upload.upload_url, this.api.getAxiosInstance().defaults.baseURL ?? undefined);
      // Create-only: upload_url names a freshly minted key, so the PUT must never overwrite one.
      await axios.put(target.toString(), bytes, {
        headers: { 'Content-Type': mimeType, 'If-None-Match': '*' },
        timeout: TIMEOUT_MS.download,
        maxBodyLength: Infinity,
      });
    } catch (error) {
      throw toMediaError(error, 'Uploading the input image');
    }
    return upload;
  }

  async getFile(fileId: string): Promise<FileResponse> {
    try {
      return FileResponseSchema.parse(
        await this.api.get<unknown>(`/api/v1/files/${encodeURIComponent(fileId)}`, { timeout: TIMEOUT_MS.download })
      );
    } catch (error) {
      throw toMediaError(error, 'Checking the input image');
    }
  }

  /**
   * Open a finished clip for streaming to disk. Same origin rule as `fetchGenerated`: a signed
   * absolute URL is fetched bare so the access token never reaches storage, and a relative one
   * is this backend's own file route. Anything but http(s) is refused outright.
   */
  async openVideoDownload(url: string, signal: AbortSignal): Promise<{ stream: Readable; contentType: string }> {
    const absolute = /^https?:\/\//i.test(url);
    if (!absolute && (!url.startsWith('/') || url.startsWith('//'))) {
      throw new MediaToolError('The server returned a video address this app will not load.');
    }
    try {
      const config = { responseType: 'stream' as const, timeout: TIMEOUT_MS.video, signal };
      const response = absolute
        ? await axios.get<Readable>(url, config)
        : await this.api.getAxiosInstance().get<Readable>(url, config);
      const header = response.headers['content-type'];
      return { stream: response.data, contentType: typeof header === 'string' ? header : '' };
    } catch (error) {
      throw toMediaError(error, 'Downloading the video');
    }
  }

  /**
   * Synthesize speech. Always asks for `encoding: 'base64'`, because the JSON body is the only
   * form that carries the provider substitution and the saved-copy id as data rather than as
   * response headers a caller has to know to look for.
   */
  async synthesizeSpeech(request: Omit<TTSRequest, 'encoding'>): Promise<TtsBase64Response> {
    try {
      const payer = await this.payer();
      const body = await this.withRun(run =>
        this.api.post<unknown>(
          '/api/ai/tts',
          { ...request, ...payer, ...run, encoding: 'base64' },
          { timeout: TIMEOUT_MS.audio }
        )
      );
      return ttsBase64ResponseSchema.parse(body);
    } catch (error) {
      throw toPaidCallError(error, 'Speech synthesis');
    }
  }

  async generateSoundEffect(request: SoundEffectsRequest): Promise<GeneratedAudio> {
    return this.postForAudio(
      '/api/ai/sound-effects',
      { ...request, ...(await this.payer()) },
      'Sound-effect generation'
    );
  }

  /** Music models this caller can use right now, in the server's order. */
  async listMusicModels(): Promise<PublicMusicModel[]> {
    try {
      const response = await this.api.get<unknown>('/api/v1/music-models', { timeout: TIMEOUT_MS.download });
      return parseMusicModels(response);
    } catch (error) {
      throw toMediaError(error, 'Listing music models');
    }
  }

  /**
   * Start a music job. Returns as soon as it is queued; the song renders server-side.
   * `idempotencyKey` makes a retried submit of the same call return the same job, not a second bill.
   *
   * Takes no abort signal on purpose: a submit cut off mid-flight would leave a job billing that
   * the caller has no id for, so a stop is handled by cancelling the job this returns instead.
   */
  async createMusicGeneration(body: CreateMusicGenerationBody, idempotencyKey: string): Promise<MusicGeneration> {
    try {
      const payer = await this.payer('/api/v1/music-generations', idempotencyKey);
      const response = await this.withRun(run =>
        this.api.post<unknown>(
          '/api/v1/music-generations',
          { ...body, ...payer, ...run },
          { timeout: TIMEOUT_MS.submit, headers: { 'Idempotency-Key': idempotencyKey } }
        )
      );
      return MusicGenerationSchema.parse(response);
    } catch (error) {
      throw toPaidCallError(error, 'Music generation');
    }
  }

  async getMusicGeneration(jobId: string, signal?: AbortSignal): Promise<MusicGeneration> {
    try {
      const response = await this.api.get<unknown>(`/api/v1/music-generations/${encodeURIComponent(jobId)}`, {
        timeout: TIMEOUT_MS.download,
        signal,
      });
      return MusicGenerationSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Reading the music job');
    }
  }

  async cancelMusicGeneration(jobId: string): Promise<MusicGeneration> {
    try {
      const response = await this.api.post<unknown>(
        `/api/v1/music-generations/${encodeURIComponent(jobId)}/cancel`,
        {},
        { timeout: TIMEOUT_MS.download }
      );
      return MusicGenerationSchema.parse(response);
    } catch (error) {
      throw toMediaError(error, 'Cancelling the song');
    }
  }

  /**
   * Null is stated, never omitted: an omitted payer bills the home organization on most media routes.
   * With an Idempotency-Key, the payer the key was first sent with is reused for its retries.
   */
  private async payer(path?: string, idempotencyKey?: string): Promise<BillingPayer> {
    const keyed = path && idempotencyKey ? `${path}|${idempotencyKey}` : null;
    const remembered = keyed ? PAYER_BY_IDEMPOTENCY_KEY.get(keyed) : undefined;
    if (remembered) return remembered;
    const payer: BillingPayer = { organization_id: (this.run?.payer ?? (await this.getPayer())).organization_id };
    if (keyed) {
      PAYER_BY_IDEMPOTENCY_KEY.set(keyed, payer);
      if (PAYER_BY_IDEMPOTENCY_KEY.size > PAYER_BY_IDEMPOTENCY_KEY_LIMIT) {
        const oldest = PAYER_BY_IDEMPOTENCY_KEY.keys().next().value;
        if (oldest !== undefined) PAYER_BY_IDEMPOTENCY_KEY.delete(oldest);
      }
    }
    return payer;
  }

  /**
   * The raw-bytes half of the Audio tag. Unlike /api/ai/tts, sound-effects and music have no
   * JSON encoding: the body IS the audio, and the saved-copy outcome rides in `X-B4M-Audio-*`
   * headers. On a failure the JSON error body arrives as bytes too, so it is decoded back into
   * place before the shared mapper reads it.
   */
  private async postForAudio(path: string, body: object, action: string): Promise<GeneratedAudio> {
    try {
      const response = await this.withRun(async run => {
        try {
          return await this.api
            .getAxiosInstance()
            .post<ArrayBuffer>(path, { ...body, ...run }, { responseType: 'arraybuffer', timeout: TIMEOUT_MS.audio });
        } catch (error) {
          throw decodeArrayBufferErrorBody(error);
        }
      });
      const header = (name: string): string | undefined => {
        const value = response.headers[name];
        return typeof value === 'string' && value ? value : undefined;
      };
      const saved = header('x-b4m-audio-saved') === 'true';
      return {
        audio: Buffer.from(response.data),
        contentType: header('content-type') ?? 'audio/mpeg',
        ...(saved ? { fabFileId: header('x-b4m-audio-fab-file-id') } : {}),
      };
    } catch (error) {
      throw toPaidCallError(decodeArrayBufferErrorBody(error), action);
    }
  }
}

/** A raw-bytes audio response, plus the saved-copy id when the server kept one. */
export interface GeneratedAudio {
  audio: Buffer;
  contentType: string;
  fabFileId?: string;
}

/**
 * Restore a JSON error body that arrived as bytes because the request asked for an arraybuffer.
 *
 * Without this every failure of a binary route reads as an opaque byte array and the server's
 * actual message - "No elevenlabs API key configured", "insufficient credits" - is lost. Mirrors
 * the same helper in packages/cli/src/mcp/b4mApiClient.ts.
 */
function decodeArrayBufferErrorBody(error: unknown): unknown {
  if (!isAxiosError(error) || !error.response) return error;
  const { data } = error.response;
  if (typeof data === 'string') {
    try {
      error.response.data = JSON.parse(data);
    } catch {
      // Non-JSON string body; leave it for the status-based fallback.
    }
    return error;
  }
  const bytes = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
  if (!bytes) return error;
  try {
    error.response.data = JSON.parse(bytes.toString('utf8'));
  } catch {
    // Non-JSON body (e.g. an HTML error page); leave it for the status-based fallback.
  }
  return error;
}

/**
 * Retry-After as milliseconds, the way RFC 9110 allows it: delta-seconds or an HTTP-date. The rate
 * limiter sends whole seconds; the date form is accepted so a proxy's rewrite is still honoured.
 */
function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** The error body these routes share; every field is optional because 5xx bodies carry none. */
interface ApiErrorBody {
  error?: string;
  message?: string;
  errorCode?: string;
  provider?: string;
  fabFileId?: string;
}

/**
 * A refusal of the request's `run`, as the error the turn acts on: a used-up budget pauses the
 * whole run (ChatService.pauseRunForBudget), and an unknown run is handled by withRunFallback.
 */
function toRunRefusal(error: unknown): RunBudgetExhaustedError | RunNotFoundError | undefined {
  if (!isAxiosError(error)) return undefined;
  const body = (error.response?.data ?? {}) as ApiErrorBody;
  const detail = body.error || body.message;
  if (isRunBudgetExhausted(error, body)) return new RunBudgetExhaustedError(detail);
  if (isRunNotFound(error, body)) return new RunNotFoundError(detail);
  return undefined;
}

/** toMediaError for a paid submit, letting a run refusal through untouched. */
function toPaidCallError(error: unknown, action: string): Error {
  if (error instanceof RunBudgetExhaustedError || error instanceof RunNotFoundError) return error;
  return toMediaError(error, action);
}

/**
 * Turn a transport failure into something a user and a model can both act on.
 *
 * `insufficient_credits` gets a notice rather than a bare message: it is the one failure the
 * user can fix, and burying "you are out of credits" in a red monospace tool error is how an
 * app ends up looking broken when it is only unpaid. `provider_not_configured` is its mirror
 * image - nothing the user can buy will help, so it must not read like a billing problem.
 */
export function toMediaError(error: unknown, action: string): MediaToolError {
  if (error instanceof MediaToolError) return error;

  if (isAxiosError(error)) {
    const mapped = fromAxiosError(error, action);
    mapped.status = error.response?.status;
    const body = z
      .object({
        code: z.string().max(100).optional().catch(undefined),
        errorCode: z.string().max(100).optional().catch(undefined),
        error: z.string().max(100).optional().catch(undefined),
      })
      .safeParse(error.response?.data);
    if (body.success) mapped.code = body.data.code ?? body.data.errorCode ?? body.data.error;
    const retryAfterMs = parseRetryAfterMs(error.response?.headers['retry-after']);
    if (retryAfterMs !== undefined) mapped.retryAfterMs = retryAfterMs;
    return mapped;
  }

  const mapped = new MediaToolError(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof SessionChangedError) mapped.requestNotStarted = error.beforeRequest;
  return mapped;
}

function fromAxiosError(error: AxiosError, action: string): MediaToolError {
  const status = error.response?.status;
  const body = (error.response?.data ?? {}) as ApiErrorBody;
  const detail = body.message || body.error;

  if (body.errorCode === 'insufficient_credits') {
    return new MediaToolError(detail || 'There are not enough credits on this account to generate that.', {
      kind: 'insufficient-credits',
      text: detail || 'Not enough credits. Nothing was generated and nothing was charged.',
    });
  }
  // Two spellings of the same capability gap: /api/ai/tts tags a 401, while the sound-effects
  // and music routes answer 503 on purpose (the caller IS authenticated - the key is missing
  // server-side, and telling them to sign in again would never fix it).
  if (body.errorCode === 'provider_not_configured' || status === 503) {
    return new MediaToolError(
      detail || 'This server has no provider key configured for that, so it cannot be generated here.'
    );
  }
  if (status === 413) {
    return new MediaToolError(
      body.fabFileId
        ? `${action} succeeded but the result is too large to return here. It was saved to the file browser as ${body.fabFileId}.`
        : `${action} succeeded but the result is too large to return here.`
    );
  }
  if (status === 401 || status === 403) {
    return new MediaToolError(`${action} was refused by the server (${status}). ${detail ?? ''}`.trim());
  }
  if (detail) return new MediaToolError(`${action} failed: ${detail}`);
  if (status) return new MediaToolError(`${action} failed with HTTP ${status}.`);
  return new MediaToolError(`${action} failed: ${error.message}`);
}
