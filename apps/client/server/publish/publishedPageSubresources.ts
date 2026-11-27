import type { z } from 'zod';
import type {
  AnnotationAnchor,
  AnnotationDto,
  CreatedPublishedPageShareLinkSchema,
  PublishedPageCommentSchema,
  PublishedPageShareLinkSchema,
} from '@bike4mind/common';
import { HTTPError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  absoluteShareLinkUrl,
  type CreateShareLinkResult,
  type ShareLinkView,
} from '@server/services/publish/shareLinks';
import { getPublishedPage, type PublishedPageRecord } from '@server/services/publish/managePublishedPages';
import { toPublishUser } from '@server/services/publish/annotations';

type PublishedPageShareLinkResource = z.infer<typeof PublishedPageShareLinkSchema>;
type CreatedPublishedPageShareLinkResponse = z.infer<typeof CreatedPublishedPageShareLinkSchema>;
type PublishedPageCommentResource = z.infer<typeof PublishedPageCommentSchema>;

const iso = (v: Date | string | null | undefined): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;

/** Built from an explicit field list: the service view carries the full token, which must never reach a list body. */
export function toShareLinkResource(view: ShareLinkView): PublishedPageShareLinkResource {
  return {
    id: view.id,
    token_hint: view.shareToken.slice(-4),
    created_at: iso(view.createdAt),
    expires_at: iso(view.expiresAt),
    view_count: view.viewCount,
    last_viewed_at: iso(view.lastViewedAt),
  };
}

export function toCreatedShareLinkResource(result: CreateShareLinkResult): CreatedPublishedPageShareLinkResponse {
  return { id: result.id, share_url: absoluteShareLinkUrl(result.shareUrl), expires_at: iso(result.expiresAt) };
}

export function toCommentResource(dto: AnnotationDto): PublishedPageCommentResource {
  const { anchor } = dto;
  return {
    id: dto.id,
    author_display_name: dto.authorDisplayName,
    body: dto.body,
    anchor: anchor
      ? {
          ...(anchor.x !== undefined && { x: anchor.x }),
          ...(anchor.y !== undefined && { y: anchor.y }),
          ...(anchor.selector !== undefined && { selector: anchor.selector }),
          ...(anchor.scrollSection !== undefined && { scroll_section: anchor.scrollSection }),
        }
      : null,
    thread_root_id: dto.threadRootId ?? null,
    artifact_version_sha: dto.artifactVersionSha ?? null,
    resolved_at: dto.resolvedAt ?? null,
    created_at: dto.createdAt,
  };
}

export function fromCommentAnchor(anchor: {
  x?: number;
  y?: number;
  selector?: string;
  scroll_section?: string;
}): AnnotationAnchor {
  const { scroll_section, ...rest } = anchor;
  return { ...rest, ...(scroll_section !== undefined && { scrollSection: scroll_section }) };
}

/**
 * The management document of a page the caller manages. A page that is missing, deleted or someone
 * else's is one 404, so v1 ids cannot be probed.
 */
export async function loadManagedPage(user: Express.User, publicId: string): Promise<PublishedPageRecord> {
  try {
    const { artifact, isManager } = await getPublishedPage({ user: toPublishUser(user), publicId });
    if (isManager) return artifact;
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
  }
  throw new NotFoundError('Published page not found', { errorCode: 'not_found' });
}

/**
 * Runs a service call and re-throws its HTTPError at the status `remap` picks, keeping message and
 * additionalInfo, so a route answers only with statuses its contract declares. `remap` returns
 * undefined to leave an error alone.
 */
export async function withStatusMap<T>(
  fn: () => Promise<T>,
  remap: (error: HTTPError) => number | undefined
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HTTPError) {
      const status = remap(error);
      if (status !== undefined && status !== error.statusCode) {
        throw new HTTPError(status, error.message, error.additionalInfo);
      }
    }
    throw error;
  }
}
