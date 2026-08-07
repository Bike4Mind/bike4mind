import type { IWorkItem, IWorkItemGraph, IWorkItemReadyResult, WorkItemStatus } from '@bike4mind/common';
import type { ApiClient } from '../auth/ApiClient.js';

/**
 * Typed wrapper over `/api/work-items`. Persistent work tracking lives in B4M's
 * Mongo rather than on disk, so items survive a CLI restart and follow the user
 * across machines.
 *
 * Auth, token refresh and the base URL all come from the shared `ApiClient`
 * (which reads `~/.bike4mind/config.json`); this class only shapes requests and
 * responses.
 */

export interface WorkItemListParams {
  status?: WorkItemStatus[];
  organizationId?: string;
  /** Case-insensitive substring match against title and description. */
  query?: string;
  page?: number;
  limit?: number;
  orderBy?: 'createdAt' | 'updatedAt' | 'title';
  orderDirection?: 'asc' | 'desc';
}

export interface WorkItemListResult {
  data: IWorkItem[];
  hasMore: boolean;
  total: number;
}

export interface CreateWorkItemInput {
  title: string;
  description?: string;
  status?: WorkItemStatus;
  dependencies?: string[];
  organizationId?: string;
}

export interface UpdateWorkItemInput {
  title?: string;
  /** `''` or `null` clears the description; omitting it leaves it untouched. */
  description?: string | null;
  status?: WorkItemStatus;
  dependencies?: string[];
  organizationId?: string;
}

export class WorkItemsClient {
  constructor(private readonly apiClient: ApiClient) {}

  async list(params: WorkItemListParams = {}): Promise<WorkItemListResult> {
    const search = new URLSearchParams();
    if (params.status?.length) search.set('status', params.status.join(','));
    if (params.organizationId) search.set('organizationId', params.organizationId);
    if (params.query) search.set('query', params.query);
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.orderBy) search.set('orderBy', params.orderBy);
    if (params.orderDirection) search.set('orderDirection', params.orderDirection);

    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return this.apiClient.get<WorkItemListResult>(`/api/work-items${suffix}`);
  }

  async get(id: string): Promise<IWorkItem> {
    return this.apiClient.get<IWorkItem>(`/api/work-items/${encodeURIComponent(id)}`);
  }

  async create(input: CreateWorkItemInput): Promise<IWorkItem> {
    return this.apiClient.post<IWorkItem>('/api/work-items', input);
  }

  async update(id: string, input: UpdateWorkItemInput): Promise<IWorkItem> {
    // ApiClient exposes get/post/put/delete only, so PATCH goes through the raw
    // axios instance - it still picks up the auth and refresh interceptors.
    const response = await this.apiClient
      .getAxiosInstance()
      .patch<IWorkItem>(`/api/work-items/${encodeURIComponent(id)}`, input);
    return response.data;
  }

  /** Convenience for the common `status: 'closed'` transition. */
  async close(id: string): Promise<IWorkItem> {
    return this.update(id, { status: 'closed' });
  }

  /** Soft delete - the item stops appearing in listings but is not erased. */
  async remove(id: string): Promise<void> {
    await this.apiClient.delete(`/api/work-items/${encodeURIComponent(id)}`);
  }

  /**
   * Open items whose dependencies are all closed. `truncated` means the backlog
   * exceeded the server's whole-graph read window, so the answer is computed
   * from a prefix and can be wrong (see IWorkItemReadyResult).
   */
  async ready(): Promise<IWorkItemReadyResult> {
    const response = await this.apiClient.get<IWorkItemReadyResult>('/api/work-items/ready');
    return { data: response?.data ?? [], truncated: response?.truncated ?? false };
  }

  async graph(): Promise<IWorkItemGraph> {
    return this.apiClient.get<IWorkItemGraph>('/api/work-items/graph');
  }
}
