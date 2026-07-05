// Confluence API client for OAuth-authenticated operations
// Supports both v1 (search) and v2 (CRUD) API endpoints

import { detectMimeType as _detectMimeType } from '../utils';
import { parseRateLimitHeaders, isNearLimit, hasRateLimitInfo, buildRateLimitLogEntry } from '../rateLimitHeaders';
import { getErrorMessage } from '../atlassian/config';

import {
  formatUserResponse,
  formatPageResponse,
  formatSearchResults,
  formatSpaceResponse,
  formatSpaceList,
  formatPageList,
  formatCommentResponse,
  formatCommentList,
  formatPageRestrictions,
} from './format';
import type {
  FormattedPage,
  FormattedSearchResults,
  FormattedSpace,
  FormattedSpaceList,
  FormattedPageList,
  FormattedComment,
  FormattedCommentList,
} from './format';

// ============================================================================
// Shared Constants
// ============================================================================

/**
 * Valid restriction operations for Confluence pages.
 * - 'read': View access restriction
 * - 'update': Edit access restriction
 */
export const RESTRICTION_OPERATIONS = ['read', 'update'] as const;
export type RestrictionOperation = (typeof RESTRICTION_OPERATIONS)[number];

/**
 * Valid subject types for Confluence page restrictions.
 * - 'user': Individual user restriction
 * - 'group': Group restriction
 */
export const RESTRICTION_SUBJECT_TYPES = ['user', 'group'] as const;
export type RestrictionSubjectType = (typeof RESTRICTION_SUBJECT_TYPES)[number];

// ============================================================================
// Types & Interfaces
// ============================================================================

export type ConfluenceEnvKeys = {
  accessToken: string;
  cloudId: string;
  siteUrl: string;
};

export interface ConfluenceConfig extends ConfluenceEnvKeys {
  webBaseUrl: string;
  apiBaseUrlV1: string;
  apiBaseUrlV2: string;
  authHeader: string;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ConfluencePage {
  id: string;
  title: string;
  type?: string;
  status?: string;
  body?: {
    storage?: {
      value: string;
      representation: string;
    };
    view?: {
      value: string;
      representation: string;
    };
  };
  space?: {
    key: string;
    name: string;
  };
  version?: {
    number: number;
  };
  ancestors?: Array<{
    id: string;
    title: string;
  }>;
  _links?: {
    webui: string;
    base: string;
  };
}

export interface ConfluenceSpace {
  id?: string;
  key: string;
  name: string;
  description?: {
    plain?: {
      value: string;
    };
  };
  type?: string;
  status?: string;
  _links?: {
    webui: string;
    base: string;
  };
}

export interface ConfluenceSearchResult {
  results: ConfluencePage[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: {
    base: string;
    context: string;
    next?: string;
    prev?: string;
  };
}

export interface ConfluencePageListResult {
  results: ConfluencePage[];
  _links?: {
    next?: string;
  };
}

export interface ConfluenceSpaceListResult {
  results: ConfluenceSpace[];
  _links?: {
    next?: string;
  };
}

export interface ConfluenceUser {
  type: string;
  accountId?: string;
  accountType?: string;
  email?: string;
  publicName?: string;
  displayName?: string;
  personalSpace?: {
    id?: string;
    key?: string;
    name?: string;
  };
}

export interface RestrictionSubject {
  type: RestrictionSubjectType;
  identifier: string;
  displayName?: string;
}

export interface OperationRestriction {
  operation: RestrictionOperation;
  subjects: RestrictionSubject[];
}

export interface PageRestrictions {
  pageId: string;
  hasRestrictions: boolean;
  restrictions: OperationRestriction[];
}

export interface RestrictionPreviewItem {
  operation: RestrictionOperation;
  restrictionType: RestrictionSubjectType;
  subject: string;
  display_subject_name?: string;
}

// ============================================================================
// Attachment Types
// ============================================================================

export interface ConfluenceAttachment {
  id: string;
  title: string;
  mediaType: string;
  fileSize: number;
  webuiLink?: string;
  downloadLink?: string;
  comment?: string;
  author?: string;
  createdAt?: string;
  version?: {
    number: number;
    createdAt: string;
  };
  _links?: {
    webui: string;
    download: string;
  };
}

export interface ConfluenceAttachmentListResult {
  results: ConfluenceAttachment[];
  _links?: {
    next?: string;
  };
}

/**
 * Maximum attachment size in bytes (25MB default for Confluence)
 */
export const CONFLUENCE_MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

// Re-export shared MIME type utilities (aliased for backwards compatibility)
export { MIME_TYPE_MAP as CONFLUENCE_MIME_TYPE_MAP, detectMimeType as detectConfluenceMimeType } from '../utils';

/**
 * Minimal shape of a raw JSON response from the Confluence REST API (v1 or v2).
 * Only fields this client reads are enumerated; the index signature covers the rest.
 * format.ts helpers narrow these into the typed `Formatted*` shapes public methods return.
 */
export interface ConfluenceApiResponse {
  id?: string;
  title?: string;
  name?: string;
  status?: string;
  accountId?: string;
  displayName?: string;
  publicName?: string;
  version?: { number?: number };
  results?: ConfluenceApiResponse[];
  downloadLink?: string;
  _links?: { webui?: string; download?: string; base?: string };
  error?: unknown;
  errors?: unknown;
  [key: string]: unknown;
}

/**
 * Raw attachment shape from the v2 `/pages/{id}/attachments` endpoint - only the
 * fields {@link ConfluenceApi.listAttachments} maps from. `id`/`title` are always
 * present; the rest are optional/expand-dependent.
 */
interface RawConfluenceAttachment {
  id: string;
  title: string;
  mediaType?: string;
  mediaTypeDescription?: string;
  fileSize?: number;
  webuiLink?: string;
  downloadLink?: string;
  comment?: string;
  version?: { number: number; createdAt: string; authorId?: string };
  history?: { createdBy?: { displayName?: string }; createdDate?: string };
  _links?: { webui?: string; download?: string };
}

/**
 * Attachment payload from the v1 upload endpoint, which nests mediaType/fileSize/
 * comment under `extensions` when top-level fields are absent. mediaType/fileSize are
 * optional here (unlike the formatted `ConfluenceAttachment`); `uploadAttachment` reads
 * `extensions` and applies defaults to satisfy the formatted contract.
 */
type UploadedAttachment = Omit<ConfluenceAttachment, 'mediaType' | 'fileSize'> & {
  mediaType?: string;
  fileSize?: number;
  extensions?: { mediaType?: string; fileSize?: number; comment?: string };
};

// ============================================================================
// Confluence API Client
// ============================================================================

export class ConfluenceApi {
  constructor(private readonly config: ConfluenceConfig) {}

  /**
   * Build URL with query parameters
   */
  private buildUrl(path: string, query: QueryParams = {}, useV1 = false): string {
    const baseUrl = useV1 ? this.config.apiBaseUrlV1 : this.config.apiBaseUrlV2;
    const base = `${baseUrl}${path}`;
    const url = new URL(base);
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === '') return;
      url.searchParams.append(key, String(value));
    });
    return url.toString();
  }

  /**
   * Make authenticated HTTP request
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown; useV1?: boolean; _retryCount?: number } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query, options.useV1);

    const headers: Record<string, string> = {
      Authorization: this.config.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Parse rate limit headers from every response.
    // MUST use console.error (stderr): MCP uses stdout for JSON-RPC, so console.log
    // would corrupt the transport channel.
    const rateLimitInfo = parseRateLimitHeaders(response.headers);
    if (hasRateLimitInfo(rateLimitInfo)) {
      const logEntry = buildRateLimitLogEntry('confluence', path, rateLimitInfo);
      console.error(JSON.stringify(logEntry));
      if (isNearLimit(rateLimitInfo)) {
        console.error(
          `[Confluence] Rate limit warning: ${rateLimitInfo.usagePercent}% used (${rateLimitInfo.remaining}/${rateLimitInfo.limit} remaining)`
        );
      }
    }

    // Handle 429 Too Many Requests with single retry
    if (response.status === 429 && (options._retryCount ?? 0) < 1) {
      // Default 5s: Atlassian docs suggest retry windows of 1-10s; 5s avoids hammering
      // while staying well under Lambda's execution budget.
      const retryAfterMs = rateLimitInfo.retryAfterMs ?? 5000;
      // Add jitter (0-1s) to prevent thundering herd when multiple requests retry simultaneously
      const jitterMs = Math.floor(Math.random() * 1000);
      const delayMs = Math.min(retryAfterMs + jitterMs, 10000); // Cap at 10s for Lambda budget
      const logEntry = buildRateLimitLogEntry('confluence', path, rateLimitInfo, true);
      console.error(JSON.stringify(logEntry));
      console.error(`[Confluence] Rate limited on ${path}, retrying after ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return this.request<T>(method, path, {
        ...options,
        _retryCount: (options._retryCount ?? 0) + 1,
      });
    }

    if (!response.ok) {
      const rawBody = await response.text();

      let errorDetail = response.statusText;
      if (rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          errorDetail = parsed?.message || parsed?.errorMessage || rawBody;
        } catch {
          errorDetail = rawBody;
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          [
            `Confluence API returned ${response.status}: ${errorDetail}`,
            'Double-check the OAuth access token:',
            '- ATLASSIAN_ACCESS_TOKEN should be a valid OAuth Bearer token from Atlassian.',
            '- ATLASSIAN_SITE_URL should be the full site URL (ex: https://<workspace>.atlassian.net/wiki).',
            'The OAuth token may have expired and needs to be refreshed.',
            'Also confirm that the user has permission to view the requested page/space.',
          ].join(' ')
        );
      }

      throw new Error(`Confluence API Error ${response.status}: ${errorDetail}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    // Handle empty responses (common for DELETE operations returning 200 OK)
    const responseText = await response.text();
    if (!responseText || responseText.trim() === '') {
      return undefined as T;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return JSON.parse(responseText) as T;
    }

    return responseText as unknown as T;
  }

  /**
   * Make v1 API request
   */
  private async requestV1<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {}
  ): Promise<T> {
    return this.request<T>(method, path, { ...options, useV1: true });
  }

  /**
   * Generic GET request (v2)
   */
  get<T>(path: string, query?: QueryParams): Promise<T> {
    return this.request('GET', path, { query });
  }

  /**
   * Generic POST request (v2)
   */
  post<T>(path: string, body: unknown, query?: QueryParams): Promise<T> {
    return this.request('POST', path, { body, query });
  }

  /**
   * Generic PUT request (v2)
   */
  put<T>(path: string, body: unknown, query?: QueryParams): Promise<T> {
    return this.request('PUT', path, { body, query });
  }

  /**
   * Generic GET request (v1)
   */
  getV1<T>(path: string, query?: QueryParams): Promise<T> {
    return this.requestV1('GET', path, { query });
  }

  /**
   * Generic POST request (v1)
   */
  postV1<T>(path: string, body: unknown, query?: QueryParams): Promise<T> {
    return this.requestV1('POST', path, { body, query });
  }

  /**
   * Build web URL for Confluence pages
   */
  buildWebUrl(relativePath?: string): string {
    if (!relativePath) {
      return this.config.webBaseUrl;
    }

    if (/^https?:\/\//i.test(relativePath)) {
      return relativePath;
    }

    const separator = relativePath.startsWith('/') ? '' : '/';
    return `${this.config.webBaseUrl}${separator}${relativePath}`;
  }

  // ============================================================================
  // High-Level API Methods
  // ============================================================================

  /**
   * Get a Confluence page by ID or search by title
   */
  async getPage(params: {
    pageId?: string;
    title?: string;
    spaceKey?: string;
    includeContent?: boolean;
  }): Promise<FormattedPage> {
    const { pageId, title, spaceKey, includeContent = true } = params;

    if (!pageId && !(title && spaceKey)) {
      throw new Error('Provide either pageId or both title and spaceKey.');
    }

    let page;
    if (pageId) {
      page = await this.get<ConfluenceApiResponse>(`/pages/${pageId}`, {
        'body-format': includeContent ? 'storage' : undefined,
      });
    } else {
      const response = await this.get<ConfluenceApiResponse>(`/pages`, {
        'space-key': spaceKey,
        title,
        'body-format': includeContent ? 'storage' : undefined,
      });
      const results = Array.isArray(response?.results) ? response.results : [];
      if (results.length === 0) {
        throw new Error(`Page with title "${title}" not found in space "${spaceKey}"`);
      }
      page = results[0];
    }

    return formatPageResponse(page, this.config.siteUrl);
  }

  /**
   * Create a new Confluence page
   */
  async createPage(params: {
    spaceId: string;
    title: string;
    content: string;
    parentId?: string;
    labels?: string[];
  }): Promise<FormattedPage> {
    const { spaceId, title, content, parentId, labels = [] } = params;

    if (!spaceId || !title || !content) {
      throw new Error('spaceId, title, and content are required to create a page.');
    }

    const pagePayload: Record<string, unknown> = {
      spaceId,
      title,
      body: {
        value: content,
        representation: 'storage',
      },
      status: 'current',
      subtype: 'live',
    };

    if (parentId) {
      pagePayload.ancestors = [{ id: parentId }];
    }

    const createdPage = await this.post<ConfluenceApiResponse>('/pages', pagePayload);

    if (labels.length) {
      await this.addLabels(createdPage?.id, labels);
    }

    return formatPageResponse(createdPage, this.config.siteUrl);
  }

  /**
   * Update an existing Confluence page
   */
  async updatePage(params: { pageId: string; title?: string; content: string }): Promise<FormattedPage> {
    const { pageId, title, content } = params;

    if (!pageId || !content) {
      throw new Error('pageId, and content are required to update a page.');
    }

    const currentPage = await this.get<ConfluenceApiResponse>(`/pages/${pageId}`);
    const currentVersion = currentPage?.version?.number;
    const currentTitle = currentPage?.title;

    if (typeof currentVersion !== 'number') {
      throw new Error(`Unable to determine current version for page ${pageId}.`);
    }

    const payload = {
      id: pageId,
      title: title || currentTitle,
      body: {
        value: content,
        representation: 'storage',
      },
      status: 'current',
      version: {
        number: currentVersion + 1,
      },
    };

    const updatedPage = await this.put<ConfluenceApiResponse>(`/pages/${pageId}`, payload);
    return formatPageResponse(updatedPage, this.config.siteUrl);
  }

  /**
   * Delete a Confluence page
   */
  async deletePage(params: { pageId: string }): Promise<void> {
    const { pageId } = params;

    if (!pageId) {
      throw new Error('pageId is required to delete a page.');
    }

    await this.request<void>('DELETE', `/pages/${pageId}`);
  }

  /**
   * Search for Confluence content using CQL (uses v1 API for better search)
   */
  async search(params: { query: string; spaceKey?: string; limit?: number }): Promise<FormattedSearchResults> {
    const { query, spaceKey, limit = 4 } = params;

    if (!query) {
      throw new Error('query is required for Confluence search.');
    }

    // Build CQL query for v1 search endpoint
    let cql = query;
    const looksLikeCQL = /\b(type|space|text|title|created|modified)\s*[=~]/.test(query);

    if (!looksLikeCQL) {
      cql = `type=page AND title ~ \"${query}\"`;
    } else if (!/\btype\s*=/.test(query)) {
      cql = `type=page AND (${query})`;
    }

    if (spaceKey && !/\bspace\s*[=~]/.test(cql)) {
      cql = `${cql} AND space=${spaceKey}`;
    }

    const searchResult = await this.getV1<ConfluenceApiResponse>('/content/search', {
      cql,
      limit: Math.min(Math.max(limit, 1), 25),
      expand: 'space,body.view',
      excerpt: 'highlight',
    });

    return formatSearchResults(searchResult, this.config.siteUrl);
  }

  /**
   * List available Confluence spaces
   */
  async listSpaces(params: { limit?: number; type?: string; expand?: string } = {}): Promise<FormattedSpaceList> {
    const { limit = 20, type, expand } = params;

    const spacesResponse = await this.get<ConfluenceApiResponse>('/spaces', {
      limit: Math.min(Math.max(limit, 1), 50),
      type,
      expand,
    });

    return formatSpaceList(spacesResponse, this.config.siteUrl);
  }

  /**
   * Get details about a specific Confluence space (v2 API)
   */
  async getSpace(params: { spaceKey: string; expand?: string }): Promise<FormattedSpace> {
    const { spaceKey, expand } = params;

    if (!spaceKey) {
      throw new Error('spaceKey is required to fetch space details.');
    }

    const response = await this.get<ConfluenceApiResponse>('/spaces', {
      keys: spaceKey,
      expand,
    });

    const results = Array.isArray(response?.results) ? response.results : [];
    if (!results.length) {
      throw new Error(`Space with key "${spaceKey}" not found.`);
    }

    return formatSpaceResponse(results[0], this.config.siteUrl);
  }

  /**
   * Get details about a specific Confluence space by ID (v2 API)
   */
  async getSpaceById(params: { spaceId: string }): Promise<FormattedSpace> {
    const { spaceId } = params;

    if (!spaceId) {
      throw new Error('spaceId is required to fetch space details.');
    }

    const space = await this.get<ConfluenceApiResponse>(`/spaces/${spaceId}`);
    return formatSpaceResponse(space, this.config.siteUrl);
  }

  /**
   * Get child pages for a given page
   */
  async getPageChildren(params: { pageId: string; limit?: number }): Promise<FormattedPageList> {
    const { pageId, limit = 25 } = params;

    if (!pageId) {
      throw new Error('pageId is required to fetch child pages.');
    }

    const children = await this.get<ConfluenceApiResponse>(`/pages/${pageId}/direct-children`, {
      limit: Math.min(Math.max(limit, 1), 50),
    });

    return formatPageList(children, this.config.siteUrl);
  }

  /**
   * List all pages in a Confluence space
   */
  async listPages(params: {
    spaceId?: string;
    usePersonalSpace?: boolean;
    limit?: number;
  }): Promise<FormattedPageList> {
    const { spaceId, usePersonalSpace = false, limit = 25 } = params;

    let finalSpaceId = spaceId;

    // If usePersonalSpace is true, fetch current user and use their personal space
    if (usePersonalSpace && !spaceId) {
      const user = await this.getCurrentUser();
      if (!user.personalSpace?.id) {
        throw new Error('Personal space not found for current user.');
      }
      finalSpaceId = user.personalSpace.id;
    }

    const query: QueryParams = {
      limit: Math.min(Math.max(limit, 1), 250),
    };

    if (finalSpaceId) {
      query['space-id'] = finalSpaceId;
    }

    const pages = await this.get<ConfluenceApiResponse>('/pages', query);
    return formatPageList(pages, this.config.siteUrl);
  }

  /**
   * Add labels to a page (uses v1 API as labels endpoint is not available in v2)
   */
  async addLabels(pageId: string | undefined, labels: string[]): Promise<void> {
    if (!pageId || !labels.length) {
      return;
    }

    try {
      const payload = labels.map(label => ({ prefix: 'global', name: label }));
      await this.postV1(`/content/${pageId}/label`, payload);
    } catch (error) {
      console.warn(`Failed to add labels to page ${pageId}:`, error);
    }
  }

  /**
   * Get information about the currently authenticated Confluence user
   */
  async getCurrentUser(): Promise<ConfluenceUser> {
    const result = await this.getV1<ConfluenceApiResponse>('/user/current', { expand: 'personalSpace' });
    return formatUserResponse(result);
  }

  /**
   * Get comments for a Confluence page (v1 API)
   */
  async getPageComments(params: {
    pageId: string;
    limit?: number;
    start?: number;
    expand?: string;
  }): Promise<FormattedCommentList> {
    const { pageId, limit = 25, start = 0, expand } = params;

    if (!pageId) {
      throw new Error('pageId is required to fetch comments.');
    }

    const comments = await this.getV1<ConfluenceApiResponse>(`/content/${pageId}/child/comment`, {
      limit: Math.min(Math.max(limit, 1), 50),
      start,
      expand: expand || 'body.storage,history.lastUpdated,history.createdBy,ancestors,extensions.inlineProperties',
    });

    return formatCommentList(comments, this.config.siteUrl);
  }

  /**
   * Get a specific comment (v1 API)
   */
  async getComment(params: { commentId: string }): Promise<FormattedComment> {
    const { commentId } = params;
    if (!commentId) throw new Error('commentId is required');

    const comment = await this.getV1<ConfluenceApiResponse>(`/content/${commentId}`, {
      expand: 'body.storage,history.lastUpdated,history.createdBy,ancestors,extensions.inlineProperties,container',
    });
    return formatCommentResponse(comment, this.config.siteUrl);
  }

  /**
   * Add a comment to a page (Uses v2 API for creation)
   */
  async addComment(params: {
    pageId: string;
    content: string;
    parentId?: string; // ID of the comment being replied to
    inlineOriginalSelection?: string; // For inline comments
  }): Promise<FormattedComment> {
    const { pageId, content, parentId, inlineOriginalSelection } = params;

    if (!pageId || !content) {
      throw new Error('pageId and content are required to add a comment.');
    }

    // 1. Inline Comments (v2)
    if (inlineOriginalSelection) {
      const payload = {
        pageId,
        body: {
          value: content,
          representation: 'storage',
        },
        inlineProperties: {
          originalSelection: inlineOriginalSelection,
        },
      };
      const result = await this.post<ConfluenceApiResponse>('/inline-comments', payload);
      return formatCommentResponse(result, this.config.siteUrl);
    }

    // 2. Footer Comments (v2). v2 footer-comments are top-level only; Atlassian v2 does
    // not support threaded replies on footer comments. parentId is attempted below but
    // may require the v1 fallback.

    // Try Structure A (Standard v2) with parentId injection (Experimental)
    const payloadA: Record<string, unknown> = {
      pageId,
      body: {
        value: content,
        representation: 'storage',
      },
    };

    if (parentId) {
      payloadA.parentId = parentId; // Attempt to send parentId to v2
    }

    // Try Structure B (Alternative/Legacy v2)
    const payloadB: Record<string, unknown> = {
      pageId,
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
    };

    if (parentId) {
      payloadB.parentId = parentId;
    }

    try {
      const result = await this.post<ConfluenceApiResponse>('/footer-comments', payloadA);
      return formatCommentResponse(result, this.config.siteUrl);
    } catch (errorA: unknown) {
      const errorAMessage = getErrorMessage(errorA);
      console.warn(`Confluence v2 footer-comments (Structure A) failed: ${errorAMessage}.`);

      // Try Structure B before giving up on v2
      try {
        const result = await this.post<ConfluenceApiResponse>('/footer-comments', payloadB);
        return formatCommentResponse(result, this.config.siteUrl);
      } catch (errorB: unknown) {
        const errorBMessage = getErrorMessage(errorB);
        console.warn(`Confluence v2 footer-comments (Structure B) failed: ${errorBMessage}. Attempting v1 fallback.`);

        // Check Permissions
        if (errorAMessage.includes('403') || errorBMessage.includes('403')) {
          throw new Error(`Permission Denied (403). Check 'write:comment:confluence' scope.`);
        }
      }
    }

    // 3. Replies (threaded) via v1 fallback - reached when v2 above failed or was skipped.

    try {
      const payload: Record<string, unknown> = {
        type: 'comment',
        container: {
          id: pageId,
          type: 'page',
        },
        body: {
          storage: {
            value: content,
            representation: 'storage',
          },
        },
      };

      if (parentId) {
        payload.ancestors = [{ id: parentId }];
      }

      const result = await this.postV1<ConfluenceApiResponse>('/content', payload);
      return formatCommentResponse(result, this.config.siteUrl);
    } catch (error: unknown) {
      if (getErrorMessage(error).includes('410')) {
        // v1 Gone (410) and v2 failed. Throw a specific error so the caller does not
        // silently simulate a threaded reply.
        throw new Error(
          'Confluence API v1 is deprecated (410) and v2 does not yet fully support threaded replies. Please create a top-level comment instead.'
        );
      }
      throw error;
    }
  }

  /**
   * Update a comment (v1 API)
   */
  async updateComment(params: {
    commentId: string;
    content: string;
    inlineOriginalSelection?: string;
  }): Promise<FormattedComment> {
    const { commentId, content, inlineOriginalSelection } = params;

    if (!commentId || !content) {
      throw new Error('commentId and content are required to update a comment.');
    }

    // 1. Fetch current comment to get version and type
    const currentComment = await this.getV1<ConfluenceApiResponse>(`/content/${commentId}`, {
      expand: 'version,body.storage',
    });

    const currentVersion = currentComment?.version?.number;
    if (typeof currentVersion !== 'number') {
      throw new Error(`Unable to determine current version for comment ${commentId}.`);
    }

    // 2. Prepare update payload
    const payload: Record<string, unknown> = {
      id: commentId,
      type: 'comment',
      status: 'current',
      title: currentComment.title, // Title usually persists for comments
      version: {
        number: currentVersion + 1,
      },
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
    };

    // Handle Inline Comment Property preservation or update
    if (inlineOriginalSelection) {
      payload.extensions = {
        inlineProperties: {
          originalSelection: inlineOriginalSelection,
        },
      };
    }

    const result = await this.put<ConfluenceApiResponse>(`/content/${commentId}`, payload);
    return formatCommentResponse(result, this.config.siteUrl);
  }

  /**
   * Delete a comment (Tries v2 footer, then v2 inline, then v1 fallback)
   */
  async deleteComment(params: { commentId: string }): Promise<void> {
    const { commentId } = params;
    if (!commentId) throw new Error('commentId is required');

    // 1. Try v2 Footer Comment Delete
    try {
      await this.request('DELETE', `/footer-comments/${commentId}`);
      return;
    } catch {
      // Ignore 404 (might be inline) or 400
    }

    // 2. Try v2 Inline Comment Delete
    try {
      await this.request('DELETE', `/inline-comments/${commentId}`);
      return;
    } catch {
      // Ignore
    }

    // 3. Fallback to v1 Content Delete
    try {
      await this.requestV1('DELETE', `/content/${commentId}`);
    } catch (error: unknown) {
      if (getErrorMessage(error).includes('410')) {
        throw new Error(
          `Failed to delete comment ${commentId}. API v1 is deprecated (410) and v2 delete failed (comment might not exist or is of a different type).`
        );
      }
      throw error;
    }
  }

  // ============================================================================
  // Page Restrictions API (v1)
  // ============================================================================

  /**
   * Validate that a user exists by account ID
   * @throws Error if user does not exist
   */
  async validateUserExists(accountId: string): Promise<{ accountId: string; displayName: string }> {
    try {
      const user = await this.getV1<ConfluenceApiResponse>('/user', { accountId });
      if (!user || user.error) {
        throw new Error(`User with account ID "${accountId}" not found.`);
      }
      return {
        accountId: user.accountId ?? accountId,
        displayName: user.displayName || user.publicName || accountId,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      throw new Error(`User with account ID "${accountId}" not found or access denied.`);
    }
  }

  /**
   * Validate that a group exists by name
   * @throws Error if group does not exist
   */
  async validateGroupExists(groupName: string): Promise<{ name: string }> {
    try {
      const group = await this.getV1<ConfluenceApiResponse>(`/group/${encodeURIComponent(groupName)}`);
      if (!group || group.error) {
        throw new Error(`Group "${groupName}" not found.`);
      }
      return { name: group.name || groupName };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      throw new Error(`Group "${groupName}" not found or access denied.`);
    }
  }

  /**
   * Get current restrictions for a Confluence page
   */
  async getPageRestrictions(params: { pageId: string }): Promise<PageRestrictions> {
    const { pageId } = params;

    if (!pageId) {
      throw new Error('pageId is required to get page restrictions.');
    }

    const result = await this.getV1<ConfluenceApiResponse>(`/content/${pageId}/restriction`, {
      expand: 'restrictions.user,restrictions.group',
    });

    return formatPageRestrictions(result, pageId);
  }

  /**
   * Add a restriction to a Confluence page
   * Validates that the user/group exists before applying the restriction.
   * Automatically includes the current user in restrictions to prevent self-lockout.
   */
  async addPageRestriction(params: {
    pageId: string;
    operation: RestrictionOperation;
    restrictionType: RestrictionSubjectType;
    subject: string;
    skipValidation?: boolean;
  }): Promise<{
    success: boolean;
    pageId: string;
    operation: string;
    restrictionType: string;
    subject: string;
    subjectDisplayName?: string;
  }> {
    const { pageId, operation, restrictionType, subject, skipValidation = false } = params;

    if (!pageId || !operation || !restrictionType || !subject) {
      throw new Error('pageId, operation, restrictionType, and subject are required to add a page restriction.');
    }

    let subjectDisplayName: string | undefined;

    // Validate user/group exists before applying restriction
    if (!skipValidation) {
      if (restrictionType === 'user') {
        const userInfo = await this.validateUserExists(subject);
        subjectDisplayName = userInfo.displayName;
      } else {
        const groupInfo = await this.validateGroupExists(subject);
        subjectDisplayName = groupInfo.name;
      }
    }

    // Get the current user's account ID to include in restrictions
    // Confluence requires the caller to be included to prevent self-lockout
    const currentUser = await this.getCurrentUser();
    const currentUserAccountId = currentUser.accountId;

    if (!currentUserAccountId) {
      throw new Error('Unable to determine current user account ID. Cannot add restrictions safely.');
    }

    // Build the user list for restrictions, always including current user
    const userList: Array<{ accountId: string }> = [];

    // Current user first, so they keep access
    userList.push({ accountId: currentUserAccountId });

    // Add the target user if it's a user restriction and not the same as current user
    if (restrictionType === 'user' && subject !== currentUserAccountId) {
      userList.push({ accountId: subject });
    }

    // v1 restriction payload: API expects an array of operation restrictions
    const restrictionPayload = [
      {
        operation,
        restrictions: {
          user: userList,
          ...(restrictionType === 'group' ? { group: [{ name: subject }] } : {}),
        },
      },
    ];

    await this.postV1(`/content/${pageId}/restriction`, restrictionPayload);

    return {
      success: true,
      pageId,
      operation,
      restrictionType,
      subject,
      subjectDisplayName,
    };
  }

  /**
   * Remove a restriction from a Confluence page
   * First checks if the restriction exists to avoid 404 errors
   */
  async removePageRestriction(params: {
    pageId: string;
    operation: RestrictionOperation;
    restrictionType: RestrictionSubjectType;
    subject: string;
  }): Promise<{
    success: boolean;
    pageId: string;
    operation: string;
    restrictionType: string;
    subject: string;
    skipped?: boolean;
    message?: string;
  }> {
    const { pageId, operation, restrictionType, subject } = params;

    if (!pageId || !operation || !restrictionType || !subject) {
      throw new Error('pageId, operation, restrictionType, and subject are required to remove a page restriction.');
    }

    // First, check if the restriction actually exists
    const currentRestrictions = await this.getPageRestrictions({ pageId });

    // Find the operation restriction (read or update)
    const operationRestriction = currentRestrictions.restrictions.find(r => r.operation === operation);

    if (!operationRestriction) {
      // No restrictions exist for this operation
      return {
        success: true,
        pageId,
        operation,
        restrictionType,
        subject,
        skipped: true,
        message: `No ${operation} restrictions exist on this page.`,
      };
    }

    // Check if the specific subject has this restriction
    const subjectExists = operationRestriction.subjects.some(
      s => s.type === restrictionType && s.identifier === subject
    );

    if (!subjectExists) {
      // The specific restriction doesn't exist
      return {
        success: true,
        pageId,
        operation,
        restrictionType,
        subject,
        skipped: true,
        message: `Restriction for ${restrictionType} "${subject}" on ${operation} operation does not exist.`,
      };
    }

    // The restriction exists, proceed with deletion
    // DELETE /content/{id}/restriction/byOperation/{operationKey}/user?accountId={accountId}
    // DELETE /content/{id}/restriction/byOperation/{operationKey}/group/{groupName}
    let deletePath: string;
    let deleteQuery: QueryParams | undefined;

    if (restrictionType === 'user') {
      deletePath = `/content/${pageId}/restriction/byOperation/${operation}/user`;
      deleteQuery = { accountId: subject };
    } else {
      deletePath = `/content/${pageId}/restriction/byOperation/${operation}/group/${encodeURIComponent(subject)}`;
    }

    await this.request<void>('DELETE', deletePath, { query: deleteQuery, useV1: true });

    return {
      success: true,
      pageId,
      operation,
      restrictionType,
      subject,
    };
  }

  // ============================================================================
  // Attachment Operations
  // ============================================================================

  /**
   * List all attachments for a page
   * Uses v2 API which works with granular OAuth scopes (read:attachment:confluence)
   */
  async listAttachments(params: { pageId: string; limit?: number }): Promise<ConfluenceAttachment[]> {
    const { pageId, limit = 50 } = params;

    if (!pageId) {
      throw new Error('pageId is required to list attachments.');
    }

    // Use v2 API for attachments - works with granular scopes (read:attachment:confluence)
    // v1 API (/content/{id}/child/attachment) requires classic scopes which may not be granted
    const result = await this.get<{ results?: RawConfluenceAttachment[] }>(`/pages/${pageId}/attachments`, {
      limit: Math.min(Math.max(limit, 1), 100),
    });

    const attachments = result?.results || [];

    // Map v2 response to our ConfluenceAttachment format
    return attachments.map(att => ({
      id: att.id,
      title: att.title,
      mediaType: att.mediaType || att.mediaTypeDescription || 'application/octet-stream',
      fileSize: att.fileSize || 0,
      webuiLink: att.webuiLink || att._links?.webui ? this.buildWebUrl(att.webuiLink || att._links?.webui) : undefined,
      downloadLink:
        att.downloadLink || att._links?.download
          ? this.buildWebUrl(att.downloadLink || att._links?.download)
          : undefined,
      comment: att.comment,
      author: att.version?.authorId || att.history?.createdBy?.displayName,
      createdAt: att.version?.createdAt || att.history?.createdDate,
      version: att.version,
    }));
  }

  /**
   * Upload an attachment to a page.
   * Confluence requires multipart/form-data with X-Atlassian-Token: no-check header.
   * Uses v1 API which properly supports OAuth attachment uploads.
   *
   * @param params.pageId - The page ID
   * @param params.filename - Name for the uploaded file
   * @param params.content - Base64-encoded file content
   * @param params.mimeType - MIME type (auto-detected if omitted)
   * @param params.comment - Optional comment describing the attachment
   */
  async uploadAttachment(params: {
    pageId: string;
    filename: string;
    content: string;
    mimeType?: string;
    comment?: string;
  }): Promise<ConfluenceAttachment> {
    const { pageId, filename, content, mimeType, comment } = params;

    if (!pageId) {
      throw new Error('pageId is required to upload an attachment.');
    }

    const binaryContent = Buffer.from(content, 'base64');

    // Check file size limit
    if (binaryContent.length > CONFLUENCE_MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `File size (${Math.round(binaryContent.length / 1024 / 1024)}MB) exceeds maximum allowed size (${CONFLUENCE_MAX_ATTACHMENT_SIZE / 1024 / 1024}MB)`
      );
    }

    // Detect MIME type if not provided
    const detectedMimeType = mimeType || _detectMimeType(filename);

    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([binaryContent], { type: detectedMimeType });
    formData.append('file', blob, filename);

    if (comment) {
      formData.append('comment', comment);
    }

    // Build URL using v1 API - v2 API doesn't support attachment uploads with OAuth
    const url = `${this.config.apiBaseUrlV1}/content/${pageId}/child/attachment`;

    // Make request with special headers for attachment upload
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.config.authHeader,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check', // Required for attachment uploads
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 413) {
        throw new Error(`File too large: The attachment exceeds Confluence's maximum file size limit.`);
      }
      throw new Error(`Confluence attachment upload error (${response.status}): ${errorBody}`);
    }

    // v1 API wraps result in a results array; handle both v1 (array) and single-object responses defensively
    const result = (await response.json()) as { results?: UploadedAttachment[] } | UploadedAttachment;
    const attachment = 'results' in result && result.results ? result.results[0] : (result as UploadedAttachment);

    if (!attachment) {
      throw new Error('Unexpected response: No attachment returned after upload');
    }

    // v1 API nests mediaType/fileSize under extensions -- extract them if top-level fields are missing
    const ext = attachment.extensions;
    return {
      id: attachment.id,
      title: attachment.title,
      mediaType: attachment.mediaType || ext?.mediaType || 'application/octet-stream',
      fileSize: attachment.fileSize ?? ext?.fileSize ?? 0,
      webuiLink: attachment._links?.webui ? this.buildWebUrl(attachment._links.webui) : undefined,
      downloadLink: attachment._links?.download ? this.buildWebUrl(attachment._links.download) : undefined,
      comment: attachment.comment || ext?.comment,
      version: attachment.version,
    };
  }

  /**
   * Download an attachment by ID.
   * Returns the file content as base64-encoded string.
   * Uses v2 API for metadata and v1 API for actual download (OAuth-compatible).
   */
  async downloadAttachment(params: { attachmentId: string }): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    content: string;
  }> {
    const { attachmentId } = params;

    if (!attachmentId) {
      throw new Error('attachmentId is required to download an attachment.');
    }

    // Get attachment metadata using v2 API
    const metadata = await this.get<RawConfluenceAttachment>(`/attachments/${attachmentId}`);

    // v2 API returns downloadLink directly or in _links
    const downloadPath = metadata.downloadLink || metadata._links?.download;
    if (!downloadPath) {
      throw new Error(`Attachment ${attachmentId} has no download URL`);
    }

    // Extract page ID from download path (format: /download/attachments/{pageId}/{filename})
    const pageIdMatch = downloadPath.match(/\/download\/attachments\/(\d+)\//);
    if (!pageIdMatch) {
      throw new Error(`Unable to extract page ID from download path: ${downloadPath}`);
    }
    const pageId = pageIdMatch[1];

    // Use v1 API endpoint for download - this works with OAuth Bearer tokens
    // The endpoint returns a 302 redirect to the actual downloadable URL
    const downloadUrl = `${this.config.apiBaseUrlV1}/content/${pageId}/child/attachment/${attachmentId}/download`;

    // Download the actual file content, following redirects
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        Authorization: this.config.authHeader,
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Failed to download attachment (${response.status}): ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentBase64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      filename: metadata.title,
      mimeType: metadata.mediaType || 'application/octet-stream',
      size: metadata.fileSize || arrayBuffer.byteLength,
      content: contentBase64,
    };
  }

  /**
   * Delete an attachment by ID.
   * Uses v2 API which works with granular OAuth scopes (write:attachment:confluence)
   */
  async deleteAttachment(params: { attachmentId: string }): Promise<void> {
    const { attachmentId } = params;

    if (!attachmentId) {
      throw new Error('attachmentId is required to delete an attachment.');
    }

    await this.request<void>('DELETE', `/attachments/${attachmentId}`);
  }
}
