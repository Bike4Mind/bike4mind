import { isAxiosError } from 'axios';
import type { z } from 'zod';
import { B4mApiError, createClient, parseRetryAfterSeconds, type B4mClient, type JsonBody } from '@bike4mind/sdk';
import { ApiClient, NotAuthenticatedError } from '../auth/ApiClient.js';
import { isProviderKeyFailure } from '../auth/providerKeyFailure.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import {
  generatedAudioResponseSchema,
  type GeneratedAudioResponse,
  type IBriefcasePrompt,
  ttsBase64ResponseSchema,
  type CitableSourceSchema,
  ttsResponseTooLargeSchema,
  supportedVoiceGenerationVendor,
  type ChatHistoryItemType,
  type GeneratedFile,
  type GenerateImageResponse,
  type ImagePromptResolution,
  type PromptBatchQueryType,
  type QuestErrorCode,
  type SessionDeleteResponse,
  type TTSRequest,
} from '@bike4mind/common';

export const NOTEBOOK_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * An empty or dot-segment id collapses `/api/sessions/{id}` to `/api/sessions`, whose DELETE wipes every
 * notebook the caller owns, so write paths refuse anything that is not an ObjectId before any request.
 */
function writableNotebookId(notebookId: string): string {
  if (!NOTEBOOK_ID_PATTERN.test(notebookId)) {
    throw new Error(`Invalid notebook id: ${JSON.stringify(notebookId)}`);
  }
  return notebookId;
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

/** The `wait: false` chat ACK: the turn is queued, its outcome arrives on the quest poll. */
export interface ChatAckResponse {
  id: string;
  status: string;
  // The requested model; the quest poll carries no model field.
  model?: string;
  // The notebook the turn was recorded in. An API-key caller that sent no `sessionId` (and any
  // caller sending `newConversation: true`) gets a freshly created notebook's id here.
  sessionId?: string;
  [key: string]: unknown;
}

export interface QuestResponse {
  id: string;
  status: string;
  sessionId: string;
  // `reply` is the visible answer text, `replies` the raw reply slots. Both are persisted while the
  // turn streams, so a running quest may already carry partial text.
  reply?: string | null;
  replies?: string[];
  // A failed turn still finishes `status: 'done'` with the explanation in the reply text, so
  // `type: 'error'` is the only reliable failure signal; `errorCode` names the reason only for the
  // billing failures that have one and its absence never means success.
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

/** Arguments for POST /api/v1/image-generations; a subset of `GenerateImageRequestBodySchema`. */
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
 * A Briefcase prompt. Catalog entries are metadata only; `promptText` ships only
 * on the by-id fetch. Name/description are picked from the stored
 * `IBriefcasePrompt` so an upstream rename is a compile error here, not a silent
 * passthrough.
 */
export type RawBriefcasePrompt = Pick<IBriefcasePrompt, 'name' | 'description'> & {
  id: string;
  promptText?: string;
};

/**
 * Typed wrapper over {@link ApiClient} exposing exactly the Bike4Mind REST
 * endpoints the MCP tools call. All routes are `baseApi()` routes that accept
 * either an OAuth JWT or an instance API key, so a caller supplies whichever it
 * has via the underlying ApiClient.
 *
 * Operations with a public contract go through `@bike4mind/sdk` (`this.sdk`), whose fetch is the
 * ApiClient's, so auth and refresh are shared. The axios `this.client` calls are routes with no public
 * contract, plus four that do have one but whose v1 shape would change the MCP output: the session and
 * project lists (v1 pages by cursor, the tools by page number) and getFile/getProject (the tools return the
 * whole document; v1 is a narrower snake_case resource).
 */
export class B4mApiClient {
  private readonly client: ApiClient;
  private readonly sdk: B4mClient;
  readonly baseURL: string;

  constructor(baseURL: string, configStore?: ConfigStore, apiKey?: string) {
    this.baseURL = baseURL;
    this.client = new ApiClient(baseURL, configStore, apiKey);
    this.sdk = createClient({ baseUrl: baseURL, fetch: this.client.fetch });
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
    return this.sdk.call('getSession', { params: { id: notebookId } });
  }

  async createNotebook(args: { name: string; projectId?: string; dataLakeId?: string }): Promise<RawNotebook> {
    return this.sdk.call('createSession', {
      body: {
        name: args.name,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.dataLakeId ? { dataLakeId: args.dataLakeId } : {}),
      },
    });
  }

  async renameNotebook(notebookId: string, name: string): Promise<RawNotebook> {
    return this.sdk.call('updateSession', { params: { id: writableNotebookId(notebookId) }, body: { name } });
  }

  /** Returns the new (cloned) notebook. */
  async cloneNotebook(notebookId: string): Promise<RawNotebook> {
    return this.sdk.call('cloneSession', { params: { id: writableNotebookId(notebookId) }, body: {} });
  }

  async deleteNotebook(notebookId: string): Promise<SessionDeleteResponse> {
    return this.sdk.call('deleteSession', { params: { id: writableNotebookId(notebookId) }, redirect: 'manual' });
  }

  /** GET /api/v1/data-lakes is cursor-paginated (`{ data, next_cursor }` body), so `toList` does not apply. */
  async listDataLakes(args: {
    limit: number;
    cursor?: string;
  }): Promise<{ data: RawDataLake[]; nextCursor: string | null }> {
    const result = await this.sdk.call('listDataLakes', {
      query: { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) },
    });
    return { data: result.data ?? [], nextCursor: result.next_cursor ?? null };
  }

  async sendChat(args: {
    notebookId?: string;
    message: string;
    model?: string;
    systemPrompt?: string;
  }): Promise<ChatAckResponse> {
    const body: JsonBody<'sendChatMessage'> = {
      // No notebookId means "start a fresh conversation": without newConversation a JWT caller
      // would post into the user's last-opened notebook (the very context bleed this endpoint was
      // fixed to remove for API keys). The new notebook's id comes back in the response.
      ...(args.notebookId ? { sessionId: args.notebookId } : { newConversation: true }),
      message: args.message,
      ...(args.model ? { model: args.model } : {}),
      ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
      // Queue the turn and poll its quest rather than hold one request open for the whole
      // completion, so the tool can report progress and honour cancellation while it waits.
      wait: false,
    };
    return this.sdk.call('sendChatMessage', { body });
  }

  async getQuest(questId: string): Promise<QuestResponse> {
    // The spec types `promptMeta` as an open record; QuestResponse narrows the citables the tools read.
    return (await this.sdk.call('getQuest', { params: { id: questId } })) as QuestResponse;
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

  /** Generate a sound effect. The SDK requests base64 and rebuilds an old server's raw-bytes answer. */
  async generateSoundEffect(args: SoundEffectArgs): Promise<GeneratedAudioResponse> {
    const body = {
      provider: args.provider,
      text: args.text,
      ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
      ...(args.promptInfluence !== undefined ? { promptInfluence: args.promptInfluence } : {}),
      ...(args.format ? { format: args.format } : {}),
    } as Parameters<B4mClient['soundEffects']>[0];
    return generatedAudioResponseSchema.parse(await this.sdk.soundEffects(body));
  }

  async synthesizeSpeech(args: Omit<TTSRequest, 'encoding'>) {
    const result = await this.sdk.tts(args as Parameters<B4mClient['tts']>[0]);
    if (result.kind === 'audio') {
      return { kind: 'audio' as const, data: ttsBase64ResponseSchema.parse(result.data) };
    }
    // Only a server predating the oversized-audio URL offload puts a saved copy on the 413. The billed audio is
    // then only reachable through its FabFile, so keep the id even when no signed URL was minted.
    const oversized = ttsResponseTooLargeSchema.parse(result.data);
    const fallbackFrom = supportedVoiceGenerationVendor.safeParse(result.fallbackFrom);
    return {
      kind: 'saved-too-large' as const,
      data: { ...oversized, fabFileId: result.data.fabFileId },
      ...(fallbackFrom.success ? { fallbackFrom: fallbackFrom.data } : {}),
    };
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResponse> {
    const body = {
      prompt: args.prompt,
      model: args.model,
      ...(args.size ? { size: args.size } : {}),
      ...(args.notebookId ? { sessionId: args.notebookId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.promptResolution ? { prompt_resolution: args.promptResolution } : {}),
    } as JsonBody<'generateImage'>;
    return (await this.sdk.call('generateImage', { body })) as GenerateImageResponse;
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
    const project = await this.sdk.call('createProject', {
      body: {
        name: args.name,
        description: args.description,
        ...(args.sessionIds?.length ? { session_ids: args.sessionIds } : {}),
        ...(args.fileIds?.length ? { file_ids: args.fileIds } : {}),
      },
    });
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      sessionIds: project.session_ids,
      fileIds: project.file_ids,
      createdAt: project.created_at ?? undefined,
      updatedAt: project.updated_at ?? undefined,
    };
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

  /**
   * POST /api/briefcase/catalog: a key -> prompts map, one entry per query key.
   *
   * The route runs csrfProtection, which exempts API-key requests but rejects a
   * login (JWT bearer) request that carries no Origin - and Node sends none. CSRF
   * defends browsers, so a non-browser client naming the backend's own origin is
   * the intended pass, not a bypass.
   */
  async getBriefcaseCatalog(
    queries: readonly PromptBatchQueryType[]
  ): Promise<Record<string, RawBriefcasePrompt[] | undefined>> {
    const result = await this.client.post<{ catalog: Record<string, RawBriefcasePrompt[]> }>(
      '/api/briefcase/catalog',
      { queries },
      { headers: { Origin: new URL(this.baseURL).origin } }
    );
    return result.catalog;
  }

  async getBriefcasePrompt(promptId: string): Promise<RawBriefcasePrompt> {
    const result = await this.client.get<{ prompt: RawBriefcasePrompt }>(
      `/api/briefcase/prompts/${encodeURIComponent(promptId)}`
    );
    return result.prompt;
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
  const failure = httpFailure(error);
  if (!failure) return error instanceof Error ? error.message : String(error);
  const { status, data } = failure;
  if (status === 401) {
    // A provider-key failure also wears a 401 (e.g. /api/ai/tts); re-authenticating
    // to Bike4Mind would not fix it, so surface the server's message instead.
    const providerKeyMessage = providerKeyFailureMessage(data);
    if (providerKeyMessage) return providerKeyMessage;
    return 'authentication failed (run `b4m login` or set B4M_API_KEY)';
  }
  if (status === 403) {
    // requireFeatureEnabled answers 403 too; no key scope fixes an instance-disabled feature.
    if ((data as { code?: unknown } | undefined)?.code === 'FEATURE_DISABLED') {
      return 'feature disabled on this Bike4Mind instance (ask an admin to enable it)';
    }
    // csrfProtection answers 403 when no Origin matches the deployment's APP_URL and
    // names the expected origin in the body - the actual fix for a login (JWT) caller,
    // where the key-scope fallback below would misdirect. Other 403s keep that fallback.
    // The match is wording-based: must stay in sync with the ForbiddenError messages in
    // apps/client/server/middlewares/csrfProtection.ts.
    const csrfMessage = extractServerMessage(data);
    if (csrfMessage && /CSRF|request origin/i.test(csrfMessage)) return csrfMessage;
    const base = "API key forbidden: check the key's scopes and account access";
    return scope ? `${base} (recommended scope: ${scope})` : base;
  }
  if (status === 429) {
    const retryAfterSeconds = apiErrorRetryAfterSeconds(error);
    const serverMsg = extractServerMessage(data);
    const base = serverMsg || 'rate limit exceeded';
    return retryAfterSeconds !== undefined ? `${base} (retry after ${retryAfterSeconds}s)` : base;
  }
  if (isAxiosError(error)) {
    // A request timeout (axios aborts with ECONNABORTED; a connect timeout is ETIMEDOUT)
    // carries no response, so map it before the response-body fallbacks below.
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(error.message)) {
      return `request to Bike4Mind at ${baseURL} timed out`;
    }
    if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
      return `cannot reach Bike4Mind at ${baseURL}`;
    }
  }
  const serverMsg = extractServerMessage(data);
  if (serverMsg) {
    return serverMsg;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Status and body of an HTTP failure from either transport: a `B4mApiError` from the SDK calls or an
 * AxiosError from the axios ones (with no status when the request never got a response). Undefined for
 * anything else.
 */
function httpFailure(error: unknown): { status?: number; data?: unknown } | undefined {
  if (error instanceof B4mApiError) return { status: error.status, data: error.body };
  if (isAxiosError(error)) return { status: error.response?.status, data: error.response?.data };
  return undefined;
}

/** The HTTP status of a failed API call from either transport. */
export function apiErrorStatus(error: unknown): number | undefined {
  return httpFailure(error)?.status;
}

/** The Retry-After of a failed API call from either transport, in seconds. */
export function apiErrorRetryAfterSeconds(error: unknown): number | undefined {
  if (error instanceof B4mApiError) return error.retryAfterSeconds;
  return isAxiosError(error) ? parseRetryAfterSeconds(error.response?.headers?.['retry-after']) : undefined;
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
