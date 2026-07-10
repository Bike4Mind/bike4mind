/**
 * Format Confluence API responses to only include relevant fields for AI consumption.
 * This reduces token usage and prevents exposing unnecessary internal details.
 */

import {
  ConfluenceUser,
  PageRestrictions,
  OperationRestriction,
  RestrictionSubject,
  RESTRICTION_OPERATIONS,
  RestrictionOperation,
} from './api';

// Raw Confluence REST response shapes: only the fields the formatters read, all
// optional, plus the error envelope Confluence puts on some 2xx bodies. Hand-authored
// to a known subset (not generated) - unmodeled fields are simply ignored, missing
// fields are handled by the optional chaining + guards below.
interface RawErrorEnvelope {
  error?: unknown;
  errors?: unknown;
}
interface RawLinks {
  base?: string;
  webui?: string;
  tinyui?: string;
}
interface RawBody {
  storage?: { value?: string };
  view?: { value?: string };
}

interface RawConfluenceUser extends RawErrorEnvelope {
  type?: string;
  accountId?: string;
  accountType?: string;
  email?: string;
  publicName?: string;
  displayName?: string;
  personalSpace?: { id?: string | number; key?: string; name?: string };
}

interface RawConfluencePage extends RawErrorEnvelope {
  id?: string;
  title?: string;
  status?: string;
  spaceId?: string;
  parentId?: string;
  space?: { key?: string };
  body?: RawBody;
  version?: { number?: number };
  _links?: RawLinks;
}

interface RawConfluenceSpace extends RawErrorEnvelope {
  id?: string | number;
  key?: string;
  name?: string;
  type?: string;
  description?: { plain?: { value?: string }; value?: string };
  _links?: RawLinks;
}

interface RawConfluenceComment extends RawErrorEnvelope {
  id?: string;
  type?: string;
  status?: string;
  title?: string;
  body?: RawBody;
  history?: {
    createdBy?: RawConfluenceUser;
    createdDate?: string;
    lastUpdated?: { when?: string };
  };
  container?: { id?: string | number };
  ancestors?: Array<{ id?: string }>;
  extensions?: { inlineProperties?: unknown };
  _links?: RawLinks;
}

interface RawSearchResultItem {
  id?: string;
  title?: string;
  url?: string;
  content?: { id?: string; title?: string; history?: { lastUpdated?: { when?: string } } };
  space?: { id?: string | number; key?: string; name?: string };
  body?: RawBody;
  excerpt?: string;
  lastModified?: string;
  _links?: RawLinks;
}

interface RawListResponse<T> extends RawErrorEnvelope {
  results?: T[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: RawLinks;
}

// Generic, tolerant search envelope: the fields are optional and cover both the
// Confluence search shape and other search-result shapes, so a loosely-shaped payload
// still formats defensively rather than being rejected at the type boundary.
type RawSearchResponse = RawListResponse<RawSearchResultItem>;

interface RawRestrictionSubject {
  accountId?: string;
  username?: string;
  key?: string;
  name?: string;
  id?: string;
  displayName?: string;
  publicName?: string;
}
interface RawRestrictionSet {
  user?: { results?: RawRestrictionSubject[] } | RawRestrictionSubject[];
  group?: { results?: RawRestrictionSubject[] } | RawRestrictionSubject[];
}
interface RawRestrictionEntry {
  operation?: string;
  restrictions?: RawRestrictionSet;
  // Index signature keeps this assignable from the wider ConfluenceApiResponse (api.ts):
  // RawRestrictionsResponse.results is RawRestrictionEntry[], fed from that type's own
  // ConfluenceApiResponse[], and without an index signature TS rejects the element
  // assignment as a "weak type" (no properties in common with the source). Trade-off:
  // this disables typo-detection on property access against this one type.
  [key: string]: unknown;
}
interface RawRestrictionsResponse extends RawErrorEnvelope {
  results?: RawRestrictionEntry[];
  read?: RawRestrictionEntry;
  update?: RawRestrictionEntry;
}

// Formatted response shapes: the narrow, non-nullable return contract of the format
// helpers below. On a malformed/error payload the helpers throw rather than return a
// partial shape (the request layer already throws on non-2xx; MCP tools wrap calls in try/catch).

export interface FormattedPage {
  pageId: string;
  title: string;
  status?: string;
  spaceId?: string;
  spaceKey?: string;
  body: string;
  version?: number;
  parentId?: string;
  link: string;
}

export interface FormattedSearchResultItem {
  id: string;
  title: string;
  url: string;
  space: { id?: string; key?: string; name?: string };
  body: string;
  excerpt: string;
  lastModified?: string;
}

export interface FormattedSearchResults {
  results: FormattedSearchResultItem[];
  total: number;
  start: number;
  limit: number;
  message?: string;
}

export interface FormattedSpace {
  id?: string;
  key: string;
  name: string;
  description: string;
  type?: string;
  link: string;
}

export interface FormattedSpaceList {
  results: FormattedSpace[];
}

export interface FormattedComment {
  id: string;
  type?: string;
  status?: string;
  title?: string;
  body: string;
  author?: ConfluenceUser;
  created?: string;
  updated?: string;
  parentId?: string;
  parentCommentId?: string;
  link: string;
  inlineProperties?: unknown;
}

export interface FormattedCommentList {
  results: FormattedComment[];
  start?: number;
  limit?: number;
  size?: number;
}

export interface FormattedPageListItem {
  pageId: string;
  title: string;
  status?: string;
  parentId?: string;
  spaceId?: string;
}

export interface FormattedPageList {
  results: FormattedPageListItem[];
}

/**
 * Strips HTML tags and normalizes whitespace from text content.
 *
 * @param html - HTML string to clean
 * @returns Plain text with normalized whitespace
 */
function stripHtmlAndNormalizeWhitespace(html: string | undefined): string {
  if (!html) return '';

  return (
    html
      // Remove HTML tags
      .replace(/<[^>]*>/g, '')
      // Decode common HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Normalize whitespace: collapse multiple spaces/newlines to single space
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// Confluence v1 returns some ids (space, container) as numbers while v2 uses strings;
// normalize to the string-typed output contract.
function toIdString(id: string | number | undefined): string | undefined {
  return id === undefined ? undefined : String(id);
}

// A restriction's user/group set is either a bare array or a { results } wrapper (v1 variance).
function restrictionMembers(set: RawRestrictionSet['user']): RawRestrictionSubject[] {
  return Array.isArray(set) ? set : set?.results || [];
}

/**
 * Formats a Confluence user object to only include fields defined in ConfluenceUser interface.
 * Removes extra fields like _links, _expandable, profilePicture, operations, etc.
 *
 * @param user - Raw user object from Confluence API
 * @returns Formatted user object, or the original if it's an error response
 */
export function formatUserResponse(user: RawConfluenceUser): ConfluenceUser {
  // Request layer throws on non-2xx; this guards a 2xx body that is an error/malformed.
  if (!user || typeof user !== 'object' || user.error || user.errors) {
    throw confluenceResponseError('user', user);
  }

  return {
    // Non-null: API always returns `type` on a well-formed user object.
    type: user.type!,
    accountId: user.accountId,
    accountType: user.accountType,
    email: user.email,
    publicName: user.publicName,
    displayName: user.displayName,
    personalSpace: user.personalSpace
      ? {
          id: toIdString(user.personalSpace.id),
          key: user.personalSpace.key,
          name: user.personalSpace.name,
        }
      : undefined,
  };
}

/**
 * Builds the error thrown when a Confluence API response is malformed or carries an
 * error envelope. The request layer already throws on non-2xx responses, so this
 * only guards the rare 2xx-with-bad-body case. Callers (the MCP tools) wrap every
 * ConfluenceApi call in try/catch, so the throw surfaces as a normal error response.
 */
function confluenceResponseError(kind: string, payload: RawErrorEnvelope | null | undefined): Error {
  let detail = 'unexpected response shape';
  if (payload && typeof payload === 'object' && (payload.error || payload.errors)) {
    const raw = payload.error ?? payload.errors;
    detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return new Error(`Confluence ${kind} response was malformed: ${detail}`);
}

/**
 * Formats a Confluence page response to include only essential fields for AI.
 * Removes verbose metadata like _links, _expandable, history, operations, etc.
 *
 * @param page - Raw page object from Confluence API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted page object with essential fields only
 * @throws if the response is an error envelope or lacks the expected page shape
 */
export function formatPageResponse(page: RawConfluencePage, siteUrl: string): FormattedPage {
  // Request layer throws on non-2xx; this guards a 2xx body that is an error/malformed.
  if (!page || typeof page !== 'object' || page.error || page.errors || !page.id) {
    throw confluenceResponseError('page', page);
  }

  const baseUrl = page?._links?.base || siteUrl.replace(/\/$/, '');

  // Construct web link - handle both v1 and v2 API responses
  let link = '';
  if (page._links?.webui) {
    link = `${baseUrl}${page._links.webui}`;
  } else if (page._links?.tinyui) {
    link = `${baseUrl}${page._links.tinyui}`;
  } else {
    // Fallback for v2 API that might not have _links
    link = `${baseUrl}/pages/${page.id}`;
  }

  return {
    pageId: page.id,
    // Non-null: API always returns `title` on a well-formed page object.
    title: page.title!,
    status: page.status,
    spaceId: page.spaceId,
    spaceKey: page.space?.key,
    body: stripHtmlAndNormalizeWhitespace(page.body?.storage?.value || page.body?.view?.value),
    version: page.version?.number,
    parentId: page.parentId,
    link,
  };
}

/**
 * Formats Confluence search results to include only essential fields for AI.
 * Removes verbose metadata, breadcrumbs, and internal fields.
 *
 * @param searchResult - Raw search result from Confluence API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted search result with essential fields only
 */
export function formatSearchResults(searchResult: RawSearchResponse, siteUrl: string): FormattedSearchResults {
  if (!searchResult || typeof searchResult !== 'object' || searchResult.error || searchResult.errors) {
    throw confluenceResponseError('search', searchResult);
  }

  const baseUrl = searchResult?._links?.base || siteUrl.replace(/\/$/, '');
  const results = Array.isArray(searchResult.results)
    ? searchResult.results.map(result => {
        return {
          // The trimmed output types id/title as required; this input is intentionally
          // tolerant (see RawSearchResponse), so a loosely-shaped item may leave these
          // undefined. Force-unwrapped to satisfy the output contract, best-effort.
          id: (result.content?.id || result.id)!,
          title: (result.title || result.content?.title)!,
          url: result.url ? `${baseUrl}${result.url}` : result._links?.webui ? `${baseUrl}${result._links.webui}` : '',
          space: {
            id: toIdString(result.space?.id),
            key: result.space?.key,
            name: result.space?.name,
          },
          body: stripHtmlAndNormalizeWhitespace(result.body?.view?.value),
          excerpt: stripHtmlAndNormalizeWhitespace(result?.excerpt),
          lastModified: result.lastModified || result.content?.history?.lastUpdated?.when,
        };
      })
    : [];

  const response = {
    results,
    total: searchResult.totalSize || searchResult.size || results.length,
    start: searchResult.start || 0,
    limit: searchResult.limit || results.length,
  };

  if (results.length === 0) {
    return {
      ...response,
      message:
        'No results found. Please check your search keywords and try again with different terms or broader search criteria.',
    };
  }

  return response;
}

/**
 * Formats a Confluence space response to include only essential fields for AI.
 * Removes verbose metadata like _links, icons, _expandable, etc.
 *
 * @param space - Raw space object from Confluence API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted space object with essential fields only
 */
export function formatSpaceResponse(space: RawConfluenceSpace, siteUrl: string): FormattedSpace {
  if (!space || typeof space !== 'object' || space.error || space.errors) {
    throw confluenceResponseError('space', space);
  }

  const baseUrl = space?._links?.base || siteUrl.replace(/\/$/, '');

  // Construct web link
  const link = space._links?.webui ? `${baseUrl}${space._links.webui}` : `${baseUrl}/spaces/${space.key}`;

  return {
    id: toIdString(space.id),
    // Non-null: API always returns key/name on a well-formed space object.
    key: space.key!,
    name: space.name!,
    description: stripHtmlAndNormalizeWhitespace(space.description?.plain?.value || space.description?.value || ''),
    type: space.type,
    link,
  };
}

/**
 * Formats a list of Confluence spaces to include only essential fields for AI.
 * Removes verbose fields for each space in the list.
 *
 * @param spacesResponse - Raw spaces list response from Confluence API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted spaces response with essential fields only
 */
export function formatSpaceList(
  spacesResponse: RawListResponse<RawConfluenceSpace>,
  siteUrl: string
): FormattedSpaceList {
  if (!spacesResponse || typeof spacesResponse !== 'object' || spacesResponse.error || spacesResponse.errors) {
    throw confluenceResponseError('space list', spacesResponse);
  }

  const results = Array.isArray(spacesResponse.results)
    ? spacesResponse.results.map(space => formatSpaceResponse(space, siteUrl))
    : [];

  return {
    results,
  };
}

/**
 * Formats a Confluence comment response to include only essential fields for AI.
 */
export function formatCommentResponse(comment: RawConfluenceComment, siteUrl: string): FormattedComment {
  if (!comment || typeof comment !== 'object' || comment.error || comment.errors) {
    throw confluenceResponseError('comment', comment);
  }

  const baseUrl = comment?._links?.base || siteUrl.replace(/\/$/, '');
  const link = comment._links?.webui ? `${baseUrl}${comment._links.webui}` : '';

  return {
    // Non-null: API always returns `id` on a well-formed comment object.
    id: comment.id!,
    type: comment.type, // 'comment'
    status: comment.status,
    title: comment.title, // Usually "Re: Page Title"
    body: stripHtmlAndNormalizeWhitespace(comment.body?.storage?.value || comment.body?.view?.value),
    author: comment.history?.createdBy ? formatUserResponse(comment.history.createdBy) : undefined,
    created: comment.history?.createdDate,
    updated: comment.history?.lastUpdated?.when,
    parentId: toIdString(comment.container?.id), // Page ID
    parentCommentId: comment.ancestors?.length ? comment.ancestors[comment.ancestors.length - 1].id : undefined,
    link,
    inlineProperties: comment.extensions?.inlineProperties, // For inline comments
  };
}

/**
 * Formats a list of Confluence comments.
 */
export function formatCommentList(
  commentsResponse: RawListResponse<RawConfluenceComment>,
  siteUrl: string
): FormattedCommentList {
  if (!commentsResponse || typeof commentsResponse !== 'object' || commentsResponse.error || commentsResponse.errors) {
    throw confluenceResponseError('comment list', commentsResponse);
  }

  const results = Array.isArray(commentsResponse.results)
    ? commentsResponse.results.map(comment => formatCommentResponse(comment, siteUrl))
    : [];

  return {
    results,
    start: commentsResponse.start,
    limit: commentsResponse.limit,
    size: commentsResponse.size,
  };
}

/**
 * Formats a list of Confluence pages to include only essential fields for AI.
 * Removes verbose metadata for each page in the list.
 *
 * @param pagesResponse - Raw pages list response from Confluence API
 * @param siteUrl - The ATLASSIAN_SITE_URL from config
 * @returns Formatted pages response with essential fields only
 */
export function formatPageList(pagesResponse: RawListResponse<RawConfluencePage>, siteUrl: string): FormattedPageList {
  if (!pagesResponse || typeof pagesResponse !== 'object' || pagesResponse.error || pagesResponse.errors) {
    throw confluenceResponseError('page list', pagesResponse);
  }

  const results = Array.isArray(pagesResponse.results)
    ? pagesResponse.results.map(page => ({
        // Non-null: API always returns id/title on a well-formed page list item.
        pageId: page.id!,
        title: page.title!,
        status: page.status,
        parentId: page.parentId,
        spaceId: page.spaceId,
      }))
    : [];

  return {
    results,
  };
}

/**
 * Formats Confluence page restrictions response to a clean structure.
 * Extracts user and group restrictions for read and update operations.
 *
 * @param restrictionsResponse - Raw restrictions response from Confluence API
 * @param pageId - The page ID the restrictions belong to
 * @returns Formatted page restrictions with subjects for each operation
 */
export function formatPageRestrictions(
  restrictionsResponse: RawRestrictionsResponse,
  pageId: string
): PageRestrictions {
  // If the response is an error or doesn't have expected structure, return empty restrictions
  if (
    !restrictionsResponse ||
    typeof restrictionsResponse !== 'object' ||
    restrictionsResponse.error ||
    restrictionsResponse.errors
  ) {
    return {
      pageId,
      hasRestrictions: false,
      restrictions: [],
    };
  }

  const restrictions: OperationRestriction[] = [];

  // The Confluence API v1 returns restrictions in one of two formats:
  // 1. Array format (from GET /content/{id}/restriction):
  //    { results: [{ operation: "read", restrictions: {...} }, { operation: "update", restrictions: {...} }] }
  // 2. Object format (direct keys):
  //    { read: { restrictions: {...} }, update: { restrictions: {...} } }

  // Normalize to a map of operation -> restrictions data
  const operationsMap: Record<string, RawRestrictionEntry> = {};

  if (Array.isArray(restrictionsResponse.results)) {
    // Array format: iterate through results and build map by operation
    for (const item of restrictionsResponse.results) {
      if (item.operation && item.restrictions) {
        operationsMap[item.operation] = item;
      }
    }
  } else {
    // Object format: use direct keys
    for (const operation of RESTRICTION_OPERATIONS) {
      if (restrictionsResponse[operation]) {
        operationsMap[operation] = restrictionsResponse[operation];
      }
    }
  }

  // Process each operation's restrictions
  for (const [operation, opData] of Object.entries(operationsMap)) {
    if (!opData?.restrictions) continue;

    const subjects: RestrictionSubject[] = [];

    const users = restrictionMembers(opData.restrictions.user);
    for (const user of users) {
      subjects.push({
        type: 'user',
        // Non-null: API always returns at least one of these identifier fields.
        identifier: (user.accountId || user.username || user.key)!,
        displayName: user.displayName || user.publicName,
      });
    }

    const groups = restrictionMembers(opData.restrictions.group);
    for (const group of groups) {
      subjects.push({
        type: 'group',
        // Non-null: API always returns at least one of these identifier fields.
        identifier: (group.name || group.id)!,
        displayName: group.name,
      });
    }

    if (subjects.length > 0) {
      restrictions.push({
        operation: operation as RestrictionOperation,
        subjects,
      });
    }
  }

  return {
    pageId,
    hasRestrictions: restrictions.length > 0,
    restrictions,
  };
}
