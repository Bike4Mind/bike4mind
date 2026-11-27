import { z } from 'zod';
import { PublishTagsSchema, PUBLISH_LIMITS, PublishScopeTierSchema, EmbedOriginsSchema } from './publishedArtifact';
import { VisibilitySchema } from './artifacts';
import { CommentPolicySchema } from './annotation';
import { PublishAccessGateRequestSchema } from './artifactPublic';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

/**
 * Public (snake_case) shapes for published pages: the pages a user has published as a bundle,
 * managed through `/api/v1/published-pages`. The SPA keeps its camelCase `/api/publish/*` routes; both
 * doors call the same services in apps/client/server/services/publish.
 */

const PublicIdParamSchema = z.object({ public_id: z.string().min(1).describe('The id of the published page.') });
export { PublicIdParamSchema as PublishedPageIdParamSchema };

export const PublishedPageShareLinkParamSchema = PublicIdParamSchema.extend({
  link_id: z.string().min(1).describe('The id of the share link, from the list or create response.'),
});

export const PublishedPageCommentParamSchema = PublicIdParamSchema.extend({
  comment_id: z.string().min(1).describe('The id of the comment.'),
});

export const PublishedPageDraftParamSchema = z.object({
  draft_id: z.uuid().describe('The `draft_id` returned when the upload was created.'),
});

// Upload + finalize

const UploadFileSchema = z
  .object({
    path: z.string().min(1).describe('Path relative to the bundle root, e.g. `index.html`.'),
    size: z.int().nonnegative().describe('Size in bytes.'),
    mime_type: z.string().min(1),
  })
  .strict();

/** Strict like the other public bodies. The bundle must contain exactly one root `index.html`. */
export const CreatePublishedPageUploadRequestSchema = z
  .object({
    tier: PublishScopeTierSchema.describe('`user`, `project` or `organization`.'),
    scope_id: z.string().min(1).describe('The id of the user, project or organization the page is published under.'),
    slug: z.string().min(1).describe('The page address within the scope, lowercase kebab-case.'),
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    visibility: VisibilitySchema.optional().describe('Defaults to the scope default.'),
    tags: PublishTagsSchema.optional(),
    gated_to_group_id: z.string().optional(),
    comment_policy: CommentPolicySchema.optional().describe('Who may comment. Defaults to `none`.'),
    embed_origins: EmbedOriginsSchema.optional().describe('Exact https origins allowed to embed the page.'),
    files: z.array(UploadFileSchema).min(1).max(PUBLISH_LIMITS.maxFiles),
  })
  .strict();
export type CreatePublishedPageUploadRequest = z.infer<typeof CreatePublishedPageUploadRequestSchema>;

export const PublishedPageUploadResourceSchema = z.object({
  draft_id: z.uuid(),
  upload_urls: z
    .array(
      z.object({
        path: z.string(),
        url: z.string().describe('Send the file bytes to this URL with an HTTP PUT.'),
        expires_at: z.string().describe('ISO 8601 timestamp after which the URL stops working.'),
        headers: z.record(z.string(), z.string()).optional().describe('Headers the PUT must send.'),
      })
    )
    .describe('One upload URL per file in the request.'),
});
export type PublishedPageUploadResource = z.infer<typeof PublishedPageUploadResourceSchema>;

// The page

export const PublishedPageResourceSchema = z.object({
  public_id: z.string().describe('Stable across republishes.'),
  url: z.string().describe('The absolute URL of the page.'),
  tier: PublishScopeTierSchema,
  scope_id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  visibility: VisibilitySchema,
  comment_policy: CommentPolicySchema,
  discoverable: z.boolean().describe('Whether search engines may index the page. Takes effect for open public pages.'),
  embed_origins: z.array(z.string()),
  access_gate: z
    .object({ kind: z.enum(['passphrase', 'domain']) })
    .nullable()
    .describe('The kind of gate on the page, or `null`. The passphrase is never returned.'),
  size_bytes: z.int().nonnegative(),
  file_count: z.int().nonnegative(),
  published_at: z.string().describe('ISO 8601 timestamp of the latest publish.'),
  updated_at: z.string(),
});
export type PublishedPageResource = z.infer<typeof PublishedPageResourceSchema>;

export const ListPublishedPagesQuerySchema = PaginationQuerySchema.extend({
  q: z.string().min(1).max(200).optional().describe('Search title and description.'),
  visibility: VisibilitySchema.optional(),
});
export const ListPublishedPagesResponseSchema = paginatedResponseSchema(PublishedPageResourceSchema);

const PatchAccessGateSchema = z.union([PublishAccessGateRequestSchema, z.null()]);

/** Strict. `tags` and `embed_origins` replace the whole list; `[]` clears it. `access_gate: null` removes the gate. */
export const UpdatePublishedPageRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    tags: PublishTagsSchema.optional(),
    visibility: VisibilitySchema.optional(),
    comment_policy: CommentPolicySchema.optional(),
    discoverable: z.boolean().optional(),
    access_gate: PatchAccessGateSchema.optional(),
    embed_origins: z.array(z.string()).optional(),
  })
  .strict();
export type UpdatePublishedPageRequest = z.infer<typeof UpdatePublishedPageRequestSchema>;

// Share links. The list never carries the token or URL; the full URL is returned once, on create.

export const PublishedPageShareLinkSchema = z.object({
  id: z.string(),
  token_hint: z.string().describe('The last 4 characters of the token, to tell links apart.'),
  created_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  view_count: z.int().nonnegative(),
  last_viewed_at: z.string().nullable(),
});
export const ListPublishedPageShareLinksResponseSchema = paginatedResponseSchema(PublishedPageShareLinkSchema);

export const CreatePublishedPageShareLinkRequestSchema = z
  .object({
    expires_at: z.iso.datetime().optional().describe('Between 1 hour and 365 days from now. Omitted: never expires.'),
  })
  .strict();

export const CreatedPublishedPageShareLinkSchema = z.object({
  id: z.string(),
  share_url: z.string().describe('The absolute link. Returned only here: store it, the list does not repeat it.'),
  expires_at: z.string().nullable(),
});

// Restore

export const RestorePublishedPageRequestSchema = z
  .object({
    sha: z.string().min(1).optional().describe('The version to restore. Omitted: the previous version.'),
  })
  .strict();

// Comments

const CommentAnchorSchema = z
  .object({
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    selector: z.string().max(1024).optional(),
    scroll_section: z.string().max(256).optional(),
  })
  .strict();

export const PublishedPageCommentSchema = z.object({
  id: z.string(),
  author_display_name: z.string(),
  body: z.string(),
  anchor: CommentAnchorSchema.nullable(),
  thread_root_id: z.string().nullable(),
  artifact_version_sha: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
});
export const ListPublishedPageCommentsResponseSchema = paginatedResponseSchema(PublishedPageCommentSchema);

export const CreatePublishedPageCommentRequestSchema = z
  .object({
    body: z.string().min(1).max(5000),
    anchor: CommentAnchorSchema.optional(),
    thread_root_id: z.string().optional(),
    artifact_version_sha: z.string().optional(),
  })
  .strict();

export const UpdatePublishedPageCommentRequestSchema = z
  .object({
    body: z.string().min(1).max(5000).optional(),
    resolved: z.boolean().optional().describe('`true` resolves the comment, `false` reopens it.'),
  })
  .strict()
  .refine(v => v.body !== undefined || v.resolved !== undefined, { message: 'Nothing to update' });

// Download

export const DownloadPublishedPageFileQuerySchema = z.object({
  path: z.string().min(1).describe('Path of the file within the bundle, e.g. `assets/app.js`.'),
});
