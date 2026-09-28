import axios, { isAxiosError } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import {
  ttsBase64ResponseSchema,
  type MusicRequest,
  type SoundEffectsRequest,
  type TTSRequest,
  type TtsBase64Response,
} from '@bike4mind/common';
import type { ChatToolNotice } from '@shared/chat';

/**
 * A generation failure worth saying something specific about.
 *
 * `notice` is set for the two outcomes that are not really errors in the usual sense: running
 * out of credits (nothing was charged and nothing was produced) and, on the success path, a
 * provider standing in for the one that was asked for. See ChatToolNotice.
 */
export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly notice?: ChatToolNotice
  ) {
    super(message);
    this.name = 'MediaToolError';
  }
}

/** POST /api/ai/generate-image, narrowed to what this client sends. */
export interface GenerateImageRequest {
  prompt: string;
  model: string;
  size?: string;
  /** Notebook to file the generation under; the server creates one when this is absent. */
  sessionId?: string;
  sessionName?: string;
}

/** The subset of the quest poll this client reads. Extra fields on the wire are ignored. */
export interface QuestPoll {
  id: string;
  status?: string;
  /** 'error' is the only reliable failure signal: a failed quest still polls 200 with status 'done'. */
  type?: string;
  errorCode?: string;
  sessionId?: string;
  reply?: string;
  /** Bare generated-file basenames, e.g. `<uuid>.png`. */
  images?: string[];
  /** The same files with resolved URLs, empty when the deployment advertises no CDN base. */
  files?: { name: string; url: string; isImage: boolean; isAudio: boolean }[];
}

export interface FetchedBytes {
  bytes: Buffer;
  contentType: string;
}

/**
 * Per-request timeouts, because the app's shared client is configured for ordinary API calls
 * and these are not ordinary API calls.
 *
 * Found the hard way: the default 30s killed `POST /api/ai/generate-image` before the job was
 * even queued. That route resolves the prompt against the notebook's history with an LLM call
 * of its own before it enqueues, so the submit alone can outrun a timeout sized for a JSON read.
 * The audio routes are worse - they synthesize inline and return the bytes, so the whole
 * provider round trip happens inside the request.
 */
const TIMEOUT_MS = {
  /** Queue submit: prompt resolution plus notebook creation before it answers. */
  submit: 90_000,
  /** Synthesis happens inline on these, and a long track takes a while to render. */
  audio: 180_000,
  /** A few megabytes over whatever link the deployment is on. */
  download: 60_000,
};

/**
 * Quest statuses that mean the job will not change again. Everything else - 'running',
 * 'pending', an absent status on a freshly queued quest - is still in flight.
 */
const TERMINAL_STATUSES = new Set(['done', 'stopped']);

export function isTerminalQuest(quest: QuestPoll): boolean {
  return !!quest.status && TERMINAL_STATUSES.has(quest.status);
}

/**
 * The b4m generation endpoints this client calls, over the app's authenticated session.
 *
 * Shaped after packages/cli/src/mcp/b4mApiClient.ts: one typed method per route, with the
 * transport quirks (arraybuffer bodies, a JSON error body arriving as bytes) handled here so
 * the tools above it deal in outcomes. Not merged with that class because the CLI's is built on
 * the CLI's own ApiClient and config store; this one takes the desktop app's AuthenticatedApiClient.
 */
export class MediaApiClient {
  constructor(private readonly api: AuthenticatedApiClient) {}

  /**
   * Queue an image generation. Returns the quest to poll, not an image: the route hands the
   * request to a worker and answers immediately.
   */
  async generateImage(request: GenerateImageRequest): Promise<{ questId: string; remoteSessionId?: string }> {
    try {
      const response = await this.api.post<{ quest?: { id?: string }; session?: { id?: string } }>(
        '/api/ai/generate-image',
        request,
        { timeout: TIMEOUT_MS.submit }
      );
      const questId = response?.quest?.id;
      if (!questId) throw new MediaToolError('The server accepted the request but returned no job to follow.');
      return { questId, remoteSessionId: response?.session?.id };
    } catch (error) {
      throw toMediaError(error, 'Image generation');
    }
  }

  async getQuest(questId: string): Promise<QuestPoll> {
    try {
      return await this.api.get<QuestPoll>(`/api/quests/${encodeURIComponent(questId)}`);
    } catch (error) {
      throw toMediaError(error, 'Image generation');
    }
  }

  /**
   * Fetch a generated file the quest pointed at.
   *
   * A relative URL is this deployment's own local file proxy (self-host and personal dev stages
   * set NEXT_PUBLIC_CDN_URL to `/api/app-files/serve`), so it goes through the authenticated
   * client. An absolute one is a CDN that serves it unauthenticated, and is fetched with a bare
   * axios instance so the access token is never sent to an origin that is not the backend.
   */
  async fetchGenerated(url: string): Promise<FetchedBytes> {
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
      throw toMediaError(error, 'Downloading the generated image');
    }
  }

  /**
   * Synthesize speech. Always asks for `encoding: 'base64'`, because the JSON body is the only
   * form that carries the provider substitution and the saved-copy id as data rather than as
   * response headers a caller has to know to look for.
   */
  async synthesizeSpeech(request: Omit<TTSRequest, 'encoding'>): Promise<TtsBase64Response> {
    try {
      const body = await this.api.post<unknown>(
        '/api/ai/tts',
        { ...request, encoding: 'base64' },
        { timeout: TIMEOUT_MS.audio }
      );
      return ttsBase64ResponseSchema.parse(body);
    } catch (error) {
      throw toMediaError(error, 'Speech synthesis');
    }
  }

  generateSoundEffect(request: SoundEffectsRequest): Promise<GeneratedAudio> {
    return this.postForAudio('/api/ai/sound-effects', request, 'Sound-effect generation');
  }

  generateMusic(request: MusicRequest): Promise<GeneratedAudio> {
    return this.postForAudio('/api/ai/music', request, 'Music generation');
  }

  /**
   * The raw-bytes half of the Audio tag. Unlike /api/ai/tts, sound-effects and music have no
   * JSON encoding: the body IS the audio, and the saved-copy outcome rides in `X-B4M-Audio-*`
   * headers. On a failure the JSON error body arrives as bytes too, so it is decoded back into
   * place before the shared mapper reads it.
   */
  private async postForAudio(path: string, body: unknown, action: string): Promise<GeneratedAudio> {
    try {
      const response = await this.api
        .getAxiosInstance()
        .post<ArrayBuffer>(path, body, { responseType: 'arraybuffer', timeout: TIMEOUT_MS.audio });
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
      throw toMediaError(decodeArrayBufferErrorBody(error), action);
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

/** The error body these routes share; every field is optional because 5xx bodies carry none. */
interface ApiErrorBody {
  error?: string;
  message?: string;
  errorCode?: string;
  provider?: string;
  fabFileId?: string;
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
    const status = error.response?.status;
    const body = (error.response?.data ?? {}) as ApiErrorBody;
    const detail = body.error || body.message;

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

  return new MediaToolError(`${action} failed: ${error instanceof Error ? error.message : String(error)}`);
}
