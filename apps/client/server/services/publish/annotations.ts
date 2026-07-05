import type { AnnotationDto, CommentPolicy } from '@bike4mind/common';
import type { PublishUser } from './checkScopePermission';

/**
 * Publish - shared helpers for the annotation (collaboration) layer: map an
 * Express user to the PublishUser shape, decide whether a caller may annotate a
 * given artifact, and project an Annotation document to its public DTO.
 */

/** Narrow the authenticated Express user (a Mongoose User doc) to PublishUser. */
export function toPublishUser(user: Express.User | undefined): PublishUser | undefined {
  if (!user?.id) return undefined;
  return {
    id: String(user.id),
    username: user.username,
    isAdmin: user.isAdmin,
    organizationId: user.organizationId ? String(user.organizationId) : null,
  };
}

/** Best display name for an annotation author. Deliberately omits email - the
 *  name renders publicly to every viewer of an `open` artifact, so we never
 *  leak an address as the display name. */
export function authorDisplayName(user: Express.User): string {
  return String(user.name || user.username || 'User');
}

/**
 * Whether `user` may CREATE an annotation on an artifact, given the artifact's
 * commentPolicy and whether the user already passed the visibility (read) gate.
 * Writes always require an authenticated user.
 *
 *  - none        -> nobody (read-only)
 *  - open        -> any authenticated viewer who can see the artifact
 *  - restricted  -> owner / admin only (per-user allowlist deferred)
 */
export function canAnnotate(
  artifact: { commentPolicy: CommentPolicy; ownerId: string },
  user: PublishUser | undefined,
  passedVisibilityGate: boolean
): boolean {
  if (!user?.id) return false;
  switch (artifact.commentPolicy) {
    case 'open':
      return passedVisibilityGate;
    case 'restricted':
      return artifact.ownerId === String(user.id) || Boolean(user.isAdmin);
    case 'none':
    default:
      return false;
  }
}

/** Shape of a lean Annotation row for DTO projection. */
export interface AnnotationLean {
  _id: unknown;
  publicId: string;
  artifactVersionSha?: string;
  kind: AnnotationDto['kind'];
  authorId: string;
  authorDisplayName: string;
  body: string;
  anchor?: AnnotationDto['anchor'];
  threadRootId?: string | null;
  payload?: AnnotationDto['payload'];
  resolvedAt?: Date | null;
  createdAt: Date;
}

/** Project an Annotation document/lean row to the public DTO the widget reads. */
export function toAnnotationDto(a: AnnotationLean): AnnotationDto {
  return {
    id: String(a._id),
    publicId: a.publicId,
    kind: a.kind,
    authorId: a.authorId,
    authorDisplayName: a.authorDisplayName,
    body: a.body,
    anchor: a.anchor,
    threadRootId: a.threadRootId ?? null,
    payload: a.payload,
    artifactVersionSha: a.artifactVersionSha,
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}
