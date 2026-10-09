import { B4mApiError, B4mQuestError } from './errors';
import type { components, operations as Operations } from './generated/openapi';
import { operations } from './generated/operations';
import { parseSse } from './sse';

export type Schemas = components['schemas'];
export type OperationId = keyof Operations & keyof typeof operations;

type Op<K extends OperationId> = Operations[K];
type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 206;

export type PathParams<K extends OperationId> = Op<K> extends { parameters: { path: infer P } } ? P : never;
export type QueryParams<K extends OperationId> =
  Op<K> extends { parameters: { query?: infer Q } } ? Exclude<Q, undefined> : never;
export type JsonBody<K extends OperationId> =
  Op<K> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;
/** The union of every 2xx JSON body the operation declares; `undefined` for one with no JSON body (a 204). */
export type JsonResponse<K extends OperationId> = {
  [S in keyof Op<K>['responses']]: S extends SuccessStatus
    ? Op<K>['responses'][S] extends { content: { 'application/json': infer J } }
      ? J
      : undefined
    : never;
}[keyof Op<K>['responses']];

export type CallArgs<K extends OperationId> = ([PathParams<K>] extends [never]
  ? { params?: never }
  : { params: PathParams<K> }) &
  ([QueryParams<K>] extends [never] ? { query?: never } : { query?: QueryParams<K> }) &
  ([JsonBody<K>] extends [never]
    ? { body?: never }
    : Op<K> extends { requestBody: unknown }
      ? { body: JsonBody<K> }
      : { body?: JsonBody<K> }) & {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    // e.g. 'manual' so a destructive call never follows a redirect onto another resource.
    redirect?: RequestInit['redirect'];
  };

// Makes the args parameter optional exactly when the operation has nothing required.
type ArgsTuple<K extends OperationId> = object extends CallArgs<K> ? [args?: CallArgs<K>] : [args: CallArgs<K>];

export interface ClientOptions {
  /** Deployment origin, e.g. `https://app.example.com`. Required: the SDK bakes in no hosted URL. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` (`b4m_live_...`). */
  apiKey?: string;
  /** Called before every request; a returned token wins over `apiKey`. For JWT callers that refresh tokens. */
  getAuthToken?: () => string | undefined | Promise<string | undefined>;
  /** Custom fetch for timeouts, retries, proxies or tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Headers sent on every request. */
  headers?: Record<string, string>;
}

export interface PollOptions {
  /** First delay between polls (ms); grows 1.5x per poll up to `maxIntervalMs`. Default 1000. */
  intervalMs?: number;
  /** Delay ceiling (ms). Default 5000. */
  maxIntervalMs?: number;
  /** Give up with a `B4mQuestError` (`reason: 'timeout'`) after this long (ms). Default: never. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type Quest = Schemas['getQuestResponse200'];

export interface QuestHandle<Ack> {
  questId: string;
  ack: Ack;
  /** Polls `getQuest` until `done`/`stopped`; resolves the finished quest, throws `B4mQuestError` on failure. */
  poll(options?: PollOptions): Promise<Quest>;
}

export type CompletionStreamEvent = Schemas['createCompletionResponse200'];

type AudioOperation = 'synthesizeSpeech' | 'generateMusic' | 'generateSoundEffect';

/** Audio rebuilt from a raw-bytes answer (a server that predates `encoding`), save result from `X-B4M-Audio-*`. */
export interface RawInlineAudio {
  delivery: 'inline';
  /** Base64 of the audio bytes. */
  audio: string;
  contentType: string;
  saved: boolean;
  fabFileId?: string;
  fileName?: string;
  fileUrl?: string;
}

export type AudioResult<K extends AudioOperation> = JsonResponse<K> | RawInlineAudio;

export type TtsResult =
  | { kind: 'audio'; data: AudioResult<'synthesizeSpeech'> }
  | {
      // A server predating the oversized-audio URL offload answers 413 but keeps a saved copy; the billed audio is
      // then reachable only through that file.
      kind: 'saved-too-large';
      data: Schemas['synthesizeSpeechResponse413'] & { fabFileId: string };
      fallbackFrom?: string;
    };

interface RequestArgs {
  params?: object;
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  redirect?: RequestInit['redirect'];
}

const ABSOLUTE_URL = /^https?:\/\//i;

function buildUrl(baseUrl: string, path: string, params?: object, query?: object): string {
  const values = (params ?? {}) as Record<string, unknown>;
  const resolved = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    // An empty or dot-segment id would collapse `/x/{id}` onto `/x`, e.g. turning a single DELETE into a list DELETE.
    if (value === undefined || value === null || value === '' || value === '.' || value === '..') {
      throw new Error(`Invalid path parameter ${name}: ${JSON.stringify(value)}`);
    }
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) search.append(key, String(item));
    }
  }
  const qs = search.toString();
  const url = ABSOLUTE_URL.test(resolved) ? resolved : `${baseUrl.replace(/\/+$/, '')}${resolved}`;
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

export function createClient(options: ClientOptions) {
  if (!options.baseUrl) throw new Error('createClient: baseUrl is required');
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function send(method: string, path: string, args: RequestArgs = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    for (const [name, value] of Object.entries(args.headers ?? {})) headers.set(name, value);
    const token = (await options.getAuthToken?.()) ?? options.apiKey;
    if (token) headers.set('authorization', `Bearer ${token}`);
    let body: string | undefined;
    if (args.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(args.body);
    }
    const response = await fetchImpl(buildUrl(options.baseUrl, path, args.params, args.query), {
      method,
      headers,
      body,
      signal: args.signal,
      ...(args.redirect ? { redirect: args.redirect } : {}),
    });
    if (!response.ok) throw await B4mApiError.fromResponse(response);
    return response;
  }

  /** Any spec operation, returning the raw 2xx `Response` (for binary or streamed bodies). Non-2xx throws. */
  function raw<K extends OperationId>(operationId: K, ...[args]: ArgsTuple<K>): Promise<Response> {
    const { method, path } = operations[operationId];
    return send(method, path, args as RequestArgs);
  }

  /** Any spec operation, typed from the spec; returns the parsed JSON body (`undefined` for an empty one). A non-JSON 2xx body throws. */
  async function call<K extends OperationId>(operationId: K, ...rest: ArgsTuple<K>): Promise<JsonResponse<K>> {
    const response = await raw(operationId, ...rest);
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    if (text && !/json/i.test(contentType)) {
      throw new Error(
        `${operationId} returned ${contentType || 'a non-JSON body'}; use raw() or the tts/music/soundEffects helpers`
      );
    }
    return (text ? JSON.parse(text) : undefined) as JsonResponse<K>;
  }

  async function pollQuest(questId: string, poll: PollOptions = {}): Promise<Quest> {
    const { intervalMs = 1000, maxIntervalMs = 5000, timeoutMs, signal } = poll;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let delay = intervalMs;
    for (;;) {
      const quest = await call('getQuest', { params: { id: questId }, signal });
      if (quest.status === 'stopped') throw new B4mQuestError('stopped', quest);
      // A failed chat dispatch sets `type: 'error'` without settling `status`, so it ends the poll on its own.
      if (quest.type === 'error') throw new B4mQuestError('error', quest);
      if (quest.status === 'done') return quest;
      if (deadline !== undefined && Date.now() + delay > deadline) throw new B4mQuestError('timeout', quest);
      await sleep(delay, signal);
      delay = Math.min(delay * 1.5, maxIntervalMs);
    }
  }

  const questHandle = <Ack>(questId: string, ack: Ack): QuestHandle<Ack> => ({
    questId,
    ack,
    poll: poll => pollQuest(questId, poll),
  });

  // Always base64: a binary answer over the response ceiling is a 303 to storage that drops the X-B4M-* headers.
  async function audio<K extends AudioOperation>(
    operationId: K,
    body: Omit<JsonBody<K>, 'encoding'>,
    signal?: AbortSignal
  ): Promise<AudioResult<K>> {
    const { method, path } = operations[operationId];
    const response = await send(method, path, { body: { ...body, encoding: 'base64' }, signal });
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    if (/json/i.test(contentType)) return (await response.json()) as JsonResponse<K>;
    const saved = response.headers.get('x-b4m-audio-saved') === 'true';
    const header = (name: string) => (saved ? (response.headers.get(name) ?? undefined) : undefined);
    const result: RawInlineAudio = {
      delivery: 'inline',
      audio: toBase64(new Uint8Array(await response.arrayBuffer())),
      contentType,
      saved,
    };
    const fabFileId = header('x-b4m-audio-fab-file-id');
    const fileName = header('x-b4m-audio-file-name');
    const fileUrl = header('x-b4m-audio-file-url');
    if (fabFileId) result.fabFileId = fabFileId;
    if (fileName) result.fileName = fileName;
    if (fileUrl) result.fileUrl = fileUrl;
    return result;
  }

  return {
    call,
    raw,

    /**
     * Stream `POST /api/ai/v1/completions` as parsed events. A non-2xx before the stream throws `B4mApiError`; a
     * server `{ type: 'error' }` event is yielded, not thrown. A stream that ends without `[DONE]` and without an
     * error event throws. `url` overrides the path (absolute URLs as-is) and receives the same `Authorization`
     * header, so pass only an origin you trust.
     */
    async *completions(
      body: JsonBody<'createCompletion'>,
      opts: { signal?: AbortSignal; url?: string; headers?: Record<string, string> } = {}
    ): AsyncGenerator<CompletionStreamEvent> {
      const response = await send('POST', opts.url ?? operations.createCompletion.path, {
        body,
        signal: opts.signal,
        headers: { accept: 'text/event-stream', ...opts.headers },
      });
      if (!response.body) return;
      let sawDone = false;
      let sawError = false;
      for await (const data of parseSse(response.body, opts.signal, () => {
        sawDone = true;
      })) {
        let event: CompletionStreamEvent;
        try {
          event = JSON.parse(data) as CompletionStreamEvent;
        } catch {
          continue;
        }
        if (event.type === 'error') sawError = true;
        yield event;
      }
      if (!sawDone && !sawError) throw new Error('completion stream ended before [DONE]');
    },

    /** `POST /api/chat`, queued (the default): the turn's outcome is on the returned handle's `poll()`. */
    async chat(body: JsonBody<'sendChatMessage'>, opts: { signal?: AbortSignal } = {}) {
      const ack = await call('sendChatMessage', { body, signal: opts.signal });
      return questHandle(ack.id, ack);
    },

    async generateImage(body: JsonBody<'generateImage'>, opts: { signal?: AbortSignal } = {}) {
      const ack = await call('generateImage', { body, signal: opts.signal });
      return questHandle(ack.quest.id, ack);
    },

    /** Edited images arrive on the finished quest's `files[].url`. */
    async editImage(body: JsonBody<'editImage'>, opts: { signal?: AbortSignal } = {}) {
      const ack = await call('editImage', { body, signal: opts.signal });
      return questHandle(ack.id, ack);
    },

    pollQuest,

    async tts(body: Omit<JsonBody<'synthesizeSpeech'>, 'encoding'>, opts: { signal?: AbortSignal } = {}) {
      try {
        return { kind: 'audio', data: await audio('synthesizeSpeech', body, opts.signal) } satisfies TtsResult;
      } catch (error) {
        const tooLarge = error instanceof B4mApiError && error.status === 413 ? error : undefined;
        const data = tooLarge?.body as Schemas['synthesizeSpeechResponse413'] | undefined;
        if (!tooLarge || !data?.saved || typeof data.fabFileId !== 'string' || typeof data.provider !== 'string') {
          throw error;
        }
        const fallbackFrom = tooLarge.headers.get('x-b4m-tts-provider-fallback-from');
        const result: TtsResult = { kind: 'saved-too-large', data: { ...data, fabFileId: data.fabFileId } };
        if (fallbackFrom) result.fallbackFrom = fallbackFrom;
        return result;
      }
    },

    music(body: Omit<JsonBody<'generateMusic'>, 'encoding'>, opts: { signal?: AbortSignal } = {}) {
      return audio('generateMusic', body, opts.signal);
    },

    soundEffects(body: Omit<JsonBody<'generateSoundEffect'>, 'encoding'>, opts: { signal?: AbortSignal } = {}) {
      return audio('generateSoundEffect', body, opts.signal);
    },
  };
}

export type B4mClient = ReturnType<typeof createClient>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so the spread stays under the engine's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
