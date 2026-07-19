import { isAxiosError } from 'axios';
import { ApiClient } from '../auth/ApiClient.js';
import type { ConfigStore } from '../storage/ConfigStore.js';

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
  // The wait path returns the reply in `responses`; the scalar `response` is null.
  response?: string | null;
  responses?: string[];
  [key: string]: unknown;
}

export interface QuestResponse {
  id: string;
  status: string;
  sessionId: string;
  reply?: string;
  [key: string]: unknown;
}

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
  [key: string]: unknown;
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

  async createNotebook(args: { name?: string; projectId?: string }): Promise<RawNotebook> {
    return this.client.post<RawNotebook>('/api/sessions/create', {
      ...(args.name ? { name: args.name } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    });
  }

  async sendChat(args: { notebookId?: string; message: string; model?: string }): Promise<ChatWaitResponse> {
    return this.client.post<ChatWaitResponse>('/api/chat', {
      ...(args.notebookId ? { sessionId: args.notebookId } : {}),
      message: args.message,
      ...(args.model ? { model: args.model } : {}),
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
}

/**
 * Turn an API failure into an actionable, transport-agnostic message. `scope` is
 * the recommended API-key scope for the failing tool. A 403 can come from a
 * missing scope OR from a route-level authorization check (CASL forbidden,
 * suspended account), so the message stays broad rather than asserting a scope
 * gap that may not be the cause.
 */
export function mapApiError(error: unknown, baseURL: string, scope?: string): string {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401) {
      return 'authentication failed (run `b4m login` or set B4M_API_KEY)';
    }
    if (status === 403) {
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
 * Normalize a Retry-After header (RFC 7231: either delta-seconds or an HTTP-date)
 * to a whole, non-negative number of seconds. Returns undefined when the header is
 * absent or parses as neither, so callers can omit the retry hint entirely.
 */
function parseRetryAfterSeconds(value: unknown): number | undefined {
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
