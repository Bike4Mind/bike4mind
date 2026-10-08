import { isAxiosError } from 'axios';
import type { z } from 'zod';
import { ApiClient, NotAuthenticatedError } from '../auth/ApiClient.js';
import { isProviderKeyFailure } from '../auth/providerKeyFailure.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { ZodType, output } from 'zod';
import {
  generatedAudioResponseSchema,
  type GeneratedAudioResponse,
  ttsBase64ResponseSchema,
  type CitableSourceSchema,
  ttsResponseTooLargeSchema,
  supportedVoiceGenerationVendor,
  type ChatHistoryItemType,
  type GeneratedFile,
  type GenerateImageResponse,
  type ImagePromptResolution,
  type QuestErrorCode,
  type SessionDeleteResponse,
  type TTSRequest,
} from '@bike4mind/common';

export const NOTEBOOK_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * An empty or dot-segment id collapses `/api/sessions/{id}` to `/api/sessions`, whose DELETE wipes every
 * notebook the caller owns, so write paths refuse anything that is not an ObjectId before any request.
 */
function notebookPath(notebookId: string): string {
  if (!NOTEBOOK_ID_PATTERN.test(notebookId)) {
    throw new Error(`Invalid notebook id: ${JSON.stringify(notebookId)}`);
  }
  return `/api/sessions/${notebookId}`;
}

/**
 * A Bike4Mind notebook (session) as returned by the REST API. Only the fields the
 * MCP tools surface are typed; the rest pass through untouched.
 */
export interface RawNotebook {
  id: string;
  name?: string;
  lastUsedModel?: string | null;
  createdAt?: string;
  updatedAt?: string;
  firstCreated?: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

/** `{ data, hasMore }` list envelope; the API may also return a bare array. */
interface ListEnvelope<T> {
  data: T[];
  hasMore?: boolean;
  total?: number;
}

export interface ChatWaitResponse {
  id: string;
  status: string;
  model?: string;
  // The notebook the turn was recorded in. An API-key caller that sent no `sessionId` (and any
  // caller sending `newConversation: true`) gets a freshly created notebook's id here.
  sessionId?: string;
  // `response` is the visible answer text; `responses` is the raw reply slots. Older servers left
  // `response` null on the wait path.
  response?: string | null;
  responses?: string[];
  // Failure classifier. A failed turn still resolves 200 with the explanation in the reply
  // text, so `type: 'error'` is the only reliable failure signal; `errorCode` names the reason
  // only for the billing failures that have one and its absence never means success.
  type?: ChatHistoryItemType;
  errorCode?: QuestErrorCode;
  [key: string]: unknown;
}

export interface QuestResponse {
  id: string;
  status: string;
  sessionId: string;
  reply?: string;
  // Same classifier as ChatWaitResponse, on the polled surface - both carry it, so one branch
  // reads either.
  type?: ChatHistoryItemType;
  errorCode?: QuestErrorCode;
  // Generated-file basenames, and `files` resolves each to a ready-to-use URL (empty when the
  // server has no CDN configured).
  images?: string[];
  files?: GeneratedFile[];
  // Sources the reply was grounded in (`CitableSourceSchema` in @bike4mind/common).
  promptMeta?: { citables?: RawCitable[]; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export type RawCitable = z.infer<typeof CitableSourceSchema> & { [key: string]: unknown };

/** One matching session from POST /api/sessions/semantic-search (`scores` entries). */
export interface SessionScore {
  sessionId: string;
  sessionName?: string;
  maxSimilarity: number;
  matchingMessages: number;
  [key: string]: unknown;
}

interface SemanticSearchResponse {
  sessionIds: string[];
  count: number;
  scores?: SessionScore[];
  [key: string]: unknown;
}

export interface RawFile {
  id: string;
  fileName?: string;
  [key: string]: unknown;
}

/** Arguments for POST /api/ai/sound-effects; mirrors `soundEffectsRequestSchema`. */
export interface SoundEffectArgs {
  provider: string;
  text: string;
  durationSeconds?: number;
  promptInfluence?: number;
  format?: string;
}

/** A data lake as returned by GET /api/v1/data-lakes (`DataLakeResource`, snake_case). */
export interface RawDataLake {
  id: string;
  name: string;
  slug: string;
  datalake_tag?: string;
  description?: string | null;
  built_in?: boolean;
  status?: string;
  file_count?: number;
  [key: string]: unknown;
}

/** Arguments for POST /api/ai/generate-image; a subset of `GenerateImageRequestBodySchema`. */
export interface GenerateImageArgs {
  prompt: string;
  model: string;
  size?: string;
  notebookId?: string;
  projectId?: string;
  promptResolution?: ImagePromptResolution;
}

export interface RawProject {
  id: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface RawArtifact {
  id: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * GET /api/artifacts answers with an offset-based envelope of its own rather than
 * the `{ data, hasMore }` shape every other list route uses, so {@link ListEnvelope}
 * and `toList` do not apply here.
 */
interface ArtifactListEnvelope {
  artifacts: RawArtifact[];
  pagination?: { total: number; limit: number; offset: number; hasMore: boolean };
}

/** GET /api/artifacts/:id response; `content` ships only when includeContent=true. */
export interface ArtifactWithContent {
  artifact: RawArtifact;
  content?: unknown;
}

/**
 * Typed wrapper over {@link ApiClient} exposing exactly the Bike4Mind REST
 * endpoints the MCP tools call. All routes are `baseApi()` routes that accept
 * either an OAuth JWT or an instance API key, so a caller supplies whichever it
 * has via the underlying ApiClient.
 */
export class B4mApiClient {
  private readonly client: ApiClient;
  readonly baseURL: string;

  constructor(baseURL: string, configStore?: ConfigStore, apiKey?: string) {
    this.baseURL = baseURL;
    this.client = new ApiClient(baseURL, configStore, apiKey);
  }

  private toList<T>(result: T[] | ListEnvelope<T>): { data: T[]; hasMore: boolean } {
    if (Array.isArray(result)) {
      return { data: result, hasMore: false };
    }
    return { data: result.data ?? [], hasMore: result.hasMore ?? false };
  }

  async listNotebooks(args: {
    search?: string;
    limit: number;
    page?: number;
  }): Promise<{ data: RawNotebook[]; hasMore: boolean }> {
    const result = await this.client.get<RawNotebook[] | ListEnvelope<RawNotebook>>('/api/sessions', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        pagination: { page: args.page ?? 1, limit: args.limit },
      },
    });
    return this.toList(result);
  }

  async getNotebook(notebookId: string): Promise<RawNotebook> {
    return this.client.get<RawNotebook>(`/api/sessions/${encodeURIComponent(notebookId)}`);
  }

  async createNotebook(args: { name?: string; projectId?: string; dataLakeId?: string }): Promise<RawNotebook> {
    return this.client.post<RawNotebook>('/api/sessions/create', {
      ...(args.name ? { name: args.name } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.dataLakeId ? { dataLakeId: args.dataLakeId } : {}),
    });
  }

  async renameNotebook(notebookId: string, name: string): Promise<RawNotebook> {
    return this.client.put<RawNotebook>(notebookPath(notebookId), { name });
  }

  /** Returns the new (cloned) notebook. */
  async cloneNotebook(notebookId: string): Promise<RawNotebook> {
    return this.client.post<RawNotebook>(`${notebookPath(notebookId)}/clone`, {});
  }

  async deleteNotebook(notebookId: string): Promise<SessionDeleteResponse> {
    return this.client.delete<SessionDeleteResponse>(notebookPath(notebookId), { maxRedirects: 0 });
  }

  /**
   * GET /api/v1/data-lakes is cursor-paginated (flat `limit`/`cursor` params,
   * `{ data, next_cursor }` body), so `toList` does not apply.
   */
  async listDataLakes(args: {
    limit: number;
    cursor?: string;
  }): Promise<{ data: RawDataLake[]; nextCursor: string | null }> {
    const result = await this.client.get<{ data: RawDataLake[]; next_cursor: string | null }>('/api/v1/data-lakes', {
      params: { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) },
    });
    return { data: result.data ?? [], nextCursor: result.next_cursor ?? null };
  }

  async sendChat(args: {
    notebookId?: string;
    message: string;
    model?: string;
    systemPrompt?: string;
  }): Promise<ChatWaitResponse> {
    return this.client.post<ChatWaitResponse>('/api/chat', {
      // No notebookId means "start a fresh conversation": without newConversation a JWT caller
      // would post into the user's last-opened notebook (the very context bleed this endpoint was
      // fixed to remove for API keys). The new notebook's id comes back in the response.
      ...(args.notebookId ? { sessionId: args.notebookId } : { newConversation: true }),
      message: args.message,
      ...(args.model ? { model: args.model } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      wait: true,
    });
  }

  async getQuest(questId: string): Promise<QuestResponse> {
    return this.client.get<QuestResponse>(`/api/quests/${encodeURIComponent(questId)}`);
  }

  async searchKnowledgeBase(args: { query: string; limit: number; minSimilarity?: number }): Promise<SessionScore[]> {
    const result = await this.client.post<SemanticSearchResponse>('/api/sessions/semantic-search', {
      query: args.query,
      topK: args.limit,
      ...(args.minSimilarity !== undefined ? { minSimilarity: args.minSimilarity } : {}),
    });
    return result.scores ?? [];
  }

  async listFiles(args: {
    search?: string;
    limit: number;
    page?: number;
  }): Promise<{ data: RawFile[]; hasMore: boolean }> {
    const result = await this.client.get<RawFile[] | ListEnvelope<RawFile>>('/api/files/search', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        pagination: { page: args.page ?? 1, limit: args.limit },
      },
    });
    return this.toList(result);
  }

  async getFile(fileId: string): Promise<RawFile> {
    return this.client.get<RawFile>(`/api/files/${encodeURIComponent(fileId)}`);
  }

  /** Generate a sound effect; see {@link postGeneratedAudio} for the normalized response. */
  async generateSoundEffect(args: SoundEffectArgs): Promise<GeneratedAudioResponse> {
    return this.postGeneratedAudio(
      '/api/ai/sound-effects',
      {
        provider: args.provider,
        text: args.text,
        ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
        ...(args.promptInfluence !== undefined ? { promptInfluence: args.promptInfluence } : {}),
        ...(args.format ? { format: args.format } : {}),
      },
      generatedAudioResponseSchema
    );
  }

  async synthesizeSpeech(args: Omit<TTSRequest, 'encoding'>) {
    try {
      const data = await this.postGeneratedAudio('/api/ai/tts', args, ttsBase64ResponseSchema);
      return { kind: 'audio' as const, data };
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 413) {
        // Only a server predating the oversized-audio URL offload puts a saved copy
        // on the 413. The billed audio is then only reachable through its FabFile, so
        // keep the id even when no signed URL was minted. A substitution rides only
        // the header here.
        const oversized = ttsResponseTooLargeSchema.safeParse(error.response.data);
        if (oversized.success && oversized.data.saved && oversized.data.fabFileId) {
          const fallbackFrom = supportedVoiceGenerationVendor.safeParse(
            error.response.headers?.['x-b4m-tts-provider-fallback-from']
          );
          return {
            kind: 'saved-too-large' as const,
            data: { ...oversized.data, fabFileId: oversized.data.fabFileId },
            ...(fallbackFrom.success ? { fallbackFrom: fallbackFrom.data } : {}),
          };
        }
      }
      throw error;
    }
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResponse> {
    return this.client.post<GenerateImageResponse>('/api/ai/generate-image', {
      prompt: args.prompt,
      model: args.model,
      ...(args.size ? { size: args.size } : {}),
      ...(args.notebookId ? { sessionId: args.notebookId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.promptResolution ? { prompt_resolution: args.promptResolution } : {}),
    });
  }

  /**
   * POST a generated-audio request with `encoding: 'base64'` and normalize any
   * server's answer into the JSON shape `schema` describes. Base64 (never binary)
   * because an oversized result is a 303 in binary mode, and axios drops the
   * X-B4M headers when following it. A server predating the `encoding` field
   * ignores it and streams raw bytes with the save result in X-B4M-Audio-* headers;
   * those are rebuilt into the inline variant. The request is arraybuffer-typed, so
   * a failure body arrives as bytes; {@link decodeArrayBufferErrorBody} restores
   * its JSON shape for {@link mapApiError}.
   */
  private async postGeneratedAudio<Schema extends ZodType>(
    path: string,
    body: Record<string, unknown>,
    schema: Schema
  ): Promise<output<Schema>> {
    const response = await this.client
      .getAxiosInstance()
      .post<ArrayBuffer>(path, { ...body, encoding: 'base64' }, { responseType: 'arraybuffer' })
      .catch((error: unknown) => {
        throw decodeArrayBufferErrorBody(error);
      });

    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
    const bytes = Buffer.from(response.data);
    if (/json/i.test(contentType)) {
      return schema.parse(JSON.parse(bytes.toString('utf8')));
    }

    // Node duplicates a repeated header into an array; keep only the scalar string form.
    const headerString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const saved = String(response.headers['x-b4m-audio-saved'] ?? '') === 'true';
    return schema.parse({
      delivery: 'inline',
      audio: bytes.toString('base64'),
      contentType,
      saved,
      fabFileId: saved ? headerString(response.headers['x-b4m-audio-fab-file-id']) : undefined,
      fileName: saved ? headerString(response.headers['x-b4m-audio-file-name']) : undefined,
      fileUrl: saved ? headerString(response.headers['x-b4m-audio-file-url']) : undefined,
    });
  }

  async listProjects(args: {
    search?: string;
    limit: number;
    page?: number;
  }): Promise<{ data: RawProject[]; hasMore: boolean }> {
    const result = await this.client.get<RawProject[] | ListEnvelope<RawProject>>('/api/projects', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        pagination: { page: args.page ?? 1, limit: args.limit },
      },
    });
    return this.toList(result);
  }

  async getProject(projectId: string): Promise<RawProject> {
    return this.client.get<RawProject>(`/api/projects/${encodeURIComponent(projectId)}`);
  }

  async createProject(args: {
    name: string;
    description: string;
    sessionIds?: string[];
    fileIds?: string[];
  }): Promise<RawProject> {
    return this.client.post<RawProject>('/api/projects', {
      name: args.name,
      description: args.description,
      ...(args.sessionIds?.length ? { sessionIds: args.sessionIds } : {}),
      ...(args.fileIds?.length ? { fileIds: args.fileIds } : {}),
    });
  }

  /**
   * GET /api/artifacts takes flat `limit`/`offset` params (not the nested
   * `pagination` object the session/file/project routes use) and hard-caps
   * `limit` at 100 via a strict zod parse, so callers must not exceed it.
   */
  async listArtifacts(args: {
    search?: string;
    limit: number;
    offset?: number;
  }): Promise<{ data: RawArtifact[]; hasMore: boolean }> {
    const result = await this.client.get<ArtifactListEnvelope>('/api/artifacts', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        limit: args.limit,
        offset: args.offset ?? 0,
      },
    });
    return { data: result.artifacts ?? [], hasMore: result.pagination?.hasMore ?? false };
  }

  async getArtifact(artifactId: string): Promise<ArtifactWithContent> {
    // The route tests `req.query.includeContent === 'true'` as a string, and omits
    // content entirely otherwise, so send the literal string.
    return this.client.get<ArtifactWithContent>(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
      params: { includeContent: 'true' },
    });
  }
}

/**
 * Turn an API failure into an actionable, transport-agnostic message. `scope` is
 * the recommended API-key scope for the failing tool. A 403 can come from a
 * missing scope OR from a route-level authorization check (CASL forbidden,
 * suspended account), so the message stays broad rather than asserting a scope
 * gap that may not be the cause.
 */
export function mapApiError(error: unknown, baseURL: string, scope?: string): string {
  // No credential at all: name both fixes instead of "log in again".
  if (error instanceof NotAuthenticatedError) {
    return 'not authenticated: no credential configured (set B4M_API_KEY or run `b4m login`)';
  }
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401) {
      // A provider-key failure also wears a 401 (e.g. /api/ai/tts); re-authenticating
      // to Bike4Mind would not fix it, so surface the server's message instead.
      const providerKeyMessage = providerKeyFailureMessage(error.response?.data);
      if (providerKeyMessage) return providerKeyMessage;
      return 'authentication failed (run `b4m login` or set B4M_API_KEY)';
    }
    if (status === 403) {
      // requireFeatureEnabled answers 403 too; no key scope fixes an instance-disabled feature.
      if ((error.response?.data as { code?: unknown } | undefined)?.code === 'FEATURE_DISABLED') {
        return 'feature disabled on this Bike4Mind instance (ask an admin to enable it)';
      }
      const base = "API key forbidden: check the key's scopes and account access";
      return scope ? `${base} (recommended scope: ${scope})` : base;
    }
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(error.response?.headers?.['retry-after']);
      const serverMsg = extractServerMessage(error.response?.data);
      const base = serverMsg || 'rate limit exceeded';
      return retryAfterSeconds !== undefined ? `${base} (retry after ${retryAfterSeconds}s)` : base;
    }
    // A request timeout (axios aborts with ECONNABORTED; a connect timeout is ETIMEDOUT)
    // carries no response, so map it before the response-body fallbacks below.
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message)) {
      return `request to Bike4Mind at ${baseURL} timed out`;
    }
    if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
      return `cannot reach Bike4Mind at ${baseURL}`;
    }
    const serverMsg = extractServerMessage(error.response?.data);
    if (serverMsg) {
      return serverMsg;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A request made with `responseType: 'arraybuffer'` also decodes its error body
 * as bytes, so a JSON `{ error }` payload reaches us as a Buffer that
 * {@link mapApiError} can't read. Decode it back to a parsed object in place so
 * the server's message survives; leave a non-JSON body untouched.
 */
function decodeArrayBufferErrorBody(error: unknown): unknown {
  if (!isAxiosError(error) || !error.response) return error;
  const { data } = error.response;
  // A non-Node axios adapter may hand back an already-decoded string body; parse it
  // directly so the server message survives without going through the byte path.
  if (typeof data === 'string') {
    try {
      error.response.data = JSON.parse(data);
    } catch {
      // Non-JSON string body; leave it for mapApiError's fallback.
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
    // Non-JSON body (e.g. an HTML error page); leave it for mapApiError's fallback.
  }
  return error;
}

/**
 * Normalize a Retry-After header (RFC 7231: either delta-seconds or an HTTP-date)
 * to a whole, non-negative number of seconds. Returns undefined when the header is
 * absent or parses as neither, so callers can omit the retry hint entirely.
 */
export function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

/** Pull a human-readable message out of a JSON error body (`error` or `message` field). */
function extractServerMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return undefined;
}

function providerKeyFailureMessage(data: unknown): string | undefined {
  if (!isProviderKeyFailure(data)) return undefined;
  const base = extractServerMessage(data) ?? 'the AI provider could not be used';
  return `${base} (configure or fix the provider API key in Bike4Mind; this is not a Bike4Mind login problem)`;
}
