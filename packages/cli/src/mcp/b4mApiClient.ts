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

  async listNotebooks(args: { search?: string; limit: number }): Promise<{ data: RawNotebook[]; hasMore: boolean }> {
    const result = await this.client.get<RawNotebook[] | ListEnvelope<RawNotebook>>('/api/sessions', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        pagination: { page: 1, limit: args.limit },
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

  async listFiles(args: { search?: string; limit: number }): Promise<{ data: RawFile[]; hasMore: boolean }> {
    const result = await this.client.get<RawFile[] | ListEnvelope<RawFile>>('/api/files/search', {
      params: {
        ...(args.search ? { search: args.search } : {}),
        pagination: { page: 1, limit: args.limit },
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
 * the API-key scope the failing tool needs, named in the 403 message so a caller
 * can see exactly which permission to grant.
 */
export function mapApiError(error: unknown, baseURL: string, scope?: string): string {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401) {
      return 'authentication failed (run `b4m login` or set B4M_API_KEY)';
    }
    if (status === 403) {
      return scope ? `API key missing required scope: ${scope}` : 'API key missing a required scope';
    }
    if (status === 429) {
      const retryAfter = error.response?.headers?.['retry-after'];
      const serverMsg = extractServerMessage(error.response?.data);
      const base = serverMsg || 'rate limit exceeded';
      return retryAfter ? `${base} (retry after ${retryAfter}s)` : base;
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

/** Pull a human-readable message out of a JSON error body (`error` or `message` field). */
function extractServerMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return undefined;
}
