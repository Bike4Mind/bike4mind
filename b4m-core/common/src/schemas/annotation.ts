import { z } from 'zod';

/**
 * Annotation schemas - the collaboration layer that sits on top of a
 * PublishedArtifact. An annotation is a structured input keyed to an artifact
 * by its `publicId`. The `kind` discriminator is deliberately generic: v1 ships
 * only `comment`, but `approval`/`vote`/`signature` are reserved so the layer
 * can grow into approval workflows and e-signature without a model migration.
 *
 * Anchoring is PINS-FIRST: an annotation may carry normalized viewport
 * coordinates (0..1) and a best-effort CSS selector. Robust element-range
 * anchoring is deferred. An annotation with no anchor is document-level.
 *
 * Every annotation records the artifact version it was made against
 * (`artifactVersionSha`, the artifact's `sha256Index` at the time) so feedback
 * stays pinned to the version it critiqued - this is also the input the AI
 * revision loop (Phase C) consumes.
 */

// Kind + comment policy

export const AnnotationKindSchema = z.enum(['comment', 'approval', 'vote', 'signature']);
export type AnnotationKind = z.infer<typeof AnnotationKindSchema>;

/** Owner-controlled gate on WHO may annotate, orthogonal to artifact visibility
 *  (which controls who may VIEW). `none` = read-only (today's behavior, default).
 *  `open` = any authenticated viewer who passes the visibility gate. `restricted`
 *  = owner + explicit allowlist (allowlist UI deferred). */
export const CommentPolicySchema = z.enum(['none', 'open', 'restricted']);
export type CommentPolicy = z.infer<typeof CommentPolicySchema>;

// Anchor (pins-first)

export const AnnotationAnchorSchema = z.object({
  /** Normalized horizontal position within the artifact viewport, 0..1. */
  x: z.number().min(0).max(1).optional(),
  /** Normalized vertical position within the artifact document, 0..1. */
  y: z.number().min(0).max(1).optional(),
  /** Best-effort CSS selector path captured by the widget (may be stale). */
  selector: z.string().max(1024).optional(),
  /** Optional scroll-section label / fragment the pin was dropped in. */
  scrollSection: z.string().max(256).optional(),
});
export type AnnotationAnchor = z.infer<typeof AnnotationAnchorSchema>;

// Kind-specific payload (sparse; the DocuSign runway)

export const AnnotationPayloadSchema = z
  .object({
    /** kind === 'approval' */
    decision: z.enum(['approve', 'reject']).optional(),
    /** kind === 'vote' */
    choice: z.string().max(256).optional(),
    /** kind === 'signature' */
    signedName: z.string().max(200).optional(),
    signatureHash: z.string().max(128).optional(),
  })
  .optional();
export type AnnotationPayload = z.infer<typeof AnnotationPayloadSchema>;

export const ANNOTATION_BODY_MAX = 5000;

// The annotation aggregate

export const AnnotationSchema = z.object({
  id: z.string(),
  /** FK -> PublishedArtifact.publicId. */
  publicId: z.string(),
  /** PublishedArtifact.sha256Index at the time the annotation was made. */
  artifactVersionSha: z.string().optional(),

  kind: AnnotationKindSchema.prefault('comment'),

  authorId: z.string(),
  /** Denormalized for render - annotation authorship is immutable. */
  authorDisplayName: z.string().max(200),

  body: z.string().max(ANNOTATION_BODY_MAX),
  anchor: AnnotationAnchorSchema.optional(),

  /** null/absent = top-level; else this is a reply to another annotation. */
  threadRootId: z.string().nullish(),
  payload: AnnotationPayloadSchema,

  resolvedAt: z.date().nullish(),
  resolvedBy: z.string().nullish(),

  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
  deletedBy: z.string().nullish(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

// API request shapes

export const CreateAnnotationRequestSchema = z.object({
  body: z.string().min(1).max(ANNOTATION_BODY_MAX),
  /** v1 accepts only 'comment'; defaulted server-side. */
  kind: AnnotationKindSchema.optional(),
  anchor: AnnotationAnchorSchema.optional(),
  threadRootId: z.string().optional(),
  artifactVersionSha: z.string().optional(),
  payload: AnnotationPayloadSchema,
});
export type CreateAnnotationRequest = z.infer<typeof CreateAnnotationRequestSchema>;

export const UpdateAnnotationRequestSchema = z
  .object({
    body: z.string().min(1).max(ANNOTATION_BODY_MAX).optional(),
    /** Toggle resolution. true -> resolve, false -> reopen. */
    resolved: z.boolean().optional(),
  })
  .refine(v => v.body !== undefined || v.resolved !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateAnnotationRequest = z.infer<typeof UpdateAnnotationRequestSchema>;

// Public-facing DTO (what the viewer overlay receives)
// Dates serialized to ISO strings; no soft-delete / internal-only fields leak.

export const AnnotationDtoSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  kind: AnnotationKindSchema,
  authorId: z.string(),
  authorDisplayName: z.string(),
  body: z.string(),
  anchor: AnnotationAnchorSchema.optional(),
  threadRootId: z.string().nullish(),
  payload: AnnotationPayloadSchema,
  artifactVersionSha: z.string().optional(),
  resolvedAt: z.string().nullish(),
  createdAt: z.string(),
});
export type AnnotationDto = z.infer<typeof AnnotationDtoSchema>;

export const ListAnnotationsResponseSchema = z.object({
  annotations: z.array(AnnotationDtoSchema),
  /** Echoed so the widget can render the right affordance without a 2nd call. */
  commentPolicy: CommentPolicySchema,
});
export type ListAnnotationsResponse = z.infer<typeof ListAnnotationsResponseSchema>;

/**
 * Per-viewer comment capability - split OUT of the list response so the list can
 * be CDN-cached (shared across viewers) while this stays per-viewer + no-store.
 * Served by GET /api/publish/annotations/[publicId]/can-comment.
 */
export const CanCommentResponseSchema = z.object({
  commentPolicy: CommentPolicySchema,
  canComment: z.boolean(),
});
export type CanCommentResponse = z.infer<typeof CanCommentResponseSchema>;
