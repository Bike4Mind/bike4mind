import type {
  AnnotationDto,
  CommentPolicy,
  CreateAnnotationRequest,
  PublishVisibility,
  UpdateAnnotationRequest,
} from '@bike4mind/common';
import { Annotation, PublishedArtifact } from '@bike4mind/database';
import {
  BadRequestError,
  ForbiddenError,
  HTTPError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
// Through the barrel (a lazy cycle: only used inside functions) so callers that mock the barrel
// mock the visibility gate and owner check these services run.
import { checkVisibility, loadLiveOwner } from '@server/services/publish';
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

/** Per-author comment throttle (anti-spam). */
const COMMENT_RATE_WINDOW_MS = 60_000;
const COMMENT_RATE_MAX = 30;

interface ArtifactGateLean {
  publicId: string;
  visibility: PublishVisibility;
  ownerId: string;
  scopeId: string;
  commentPolicy: CommentPolicy;
  sha256Index?: string;
  // Required (explicit null) to match VisibilityCheckArtifact - the gate is enforced off this
  // field, so normalizing it here means no caller can pass a shape that silently bypasses it.
  accessGate: { kind: 'passphrase' | 'domain'; allowedDomains?: string[] } | null;
}

async function loadArtifact(publicId: string): Promise<ArtifactGateLean | null> {
  const doc = await PublishedArtifact.findOne({ publicId, deletedAt: null })
    .select('publicId visibility ownerId scopeId commentPolicy sha256Index accessGate')
    .lean<Omit<ArtifactGateLean, 'accessGate'> & { accessGate?: ArtifactGateLean['accessGate'] }>();
  // Same owner check as the serve route: an artifact whose page 404s must not list or take comments.
  if (!doc || !(await loadLiveOwner(doc.ownerId))) return null;
  return { ...doc, accessGate: doc.accessGate ?? null };
}

/** A passphrase gate is satisfied by the per-artifact proof the viewer holds from unlocking the page. */
const gateContext = (artifact: ArtifactGateLean, hasGateProof: boolean) => ({
  passphraseVerified: artifact.accessGate?.kind === 'passphrase' && hasGateProof,
});

/** Open-public = public AND ungated: the only state whose list may be served from a shared cache. */
const isOpenPublic = (a: ArtifactGateLean) => a.visibility === 'public' && !a.accessGate;

async function isArtifactOwner(publicId: string, userId: string): Promise<boolean> {
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null })
    .select('ownerId')
    .lean<{ ownerId: string } | null>();
  return Boolean(artifact && artifact.ownerId === userId);
}

type AnnotationLogger = { info: (msg: string) => void };

interface AnnotationCaller {
  /** Absent for an anonymous viewer, which only reads of public artifacts allow. */
  user?: Express.User;
}

const notFound = () => new NotFoundError('Not found', { errorCode: 'not_found' });
const authRequired = () => new UnauthorizedError('Authentication required', { errorCode: 'authentication_required' });

function requirePublicId(publicId: string): void {
  if (!publicId) throw new BadRequestError('Missing publicId', { errorCode: 'missing_public_id' });
}

async function loadAnnotation(publicId: string, id: string) {
  const ann = isValidObjectId(id) ? await Annotation.findOne({ _id: id, publicId, deletedAt: null }) : null;
  if (!ann) throw notFound();
  return ann;
}

async function loadVisibleArtifact(publicId: string, user: Express.User | undefined, hasGateProof: boolean) {
  const artifact = await loadArtifact(publicId);
  if (!artifact) throw notFound();
  const publishUser = toPublishUser(user);
  const vis = await checkVisibility(artifact, publishUser, gateContext(artifact, hasGateProof));
  if (!vis.ok) {
    throw new HTTPError(vis.status, vis.error, {
      errorCode: vis.status === 401 ? 'authentication_required' : 'forbidden',
    });
  }
  return { artifact, publishUser };
}

export interface ListAnnotationsInput extends AnnotationCaller {
  publicId: string;
  /** The viewer holds the artifact's passphrase proof (see requestHasGateProof). */
  hasGateProof?: boolean;
  /** A keyset page; omitted lists every annotation (the legacy routes). */
  page?: { limit: number; after?: { at: Date; id: string } };
}

export interface ListAnnotationsResult {
  annotations: AnnotationDto[];
  /** With `page`: whether rows remain past this page. */
  hasMore: boolean;
  commentPolicy: CommentPolicy;
  /** The body is identical for every viewer, so it may be served from a shared cache. */
  cacheable: boolean;
}

/** Lists an artifact's live annotations, oldest first, subject to the artifact's visibility gate. */
export async function listAnnotations({
  user,
  publicId,
  hasGateProof = false,
  page,
}: ListAnnotationsInput): Promise<ListAnnotationsResult> {
  requirePublicId(publicId);
  const { artifact } = await loadVisibleArtifact(publicId, user, hasGateProof);
  const after = page?.after;
  const query = Annotation.find({
    publicId,
    deletedAt: null,
    ...(after && {
      $or: [{ createdAt: { $gt: after.at } }, { createdAt: after.at, _id: { $gt: after.id } }],
    }),
  }).sort({ createdAt: 1, _id: 1 });
  if (page) query.limit(page.limit + 1);
  const found = await query.lean<AnnotationLean[]>();
  const hasMore = page !== undefined && found.length > page.limit;
  const rows = hasMore ? found.slice(0, page.limit) : found;
  return {
    annotations: rows.map(toAnnotationDto),
    hasMore,
    commentPolicy: artifact.commentPolicy,
    cacheable: isOpenPublic(artifact),
  };
}

export interface CreateAnnotationInput extends AnnotationCaller {
  publicId: string;
  input: CreateAnnotationRequest;
  logger: AnnotationLogger;
  hasGateProof?: boolean;
}

/** Creates a comment annotation, enforcing visibility, the comment policy and the per-author throttle. */
export async function createAnnotation({
  user,
  publicId,
  input,
  logger,
  hasGateProof = false,
}: CreateAnnotationInput): Promise<AnnotationDto> {
  if (!user?.id) throw authRequired();
  requirePublicId(publicId);
  // Reserved kinds are rejected, not silently coerced.
  if (input.kind && input.kind !== 'comment') {
    throw new BadRequestError('Only comment annotations are supported in this version', {
      errorCode: 'unsupported_annotation_kind',
    });
  }

  const { artifact, publishUser } = await loadVisibleArtifact(publicId, user, hasGateProof);

  if (!canAnnotate(artifact, publishUser, true)) {
    throw new ForbiddenError(
      artifact.commentPolicy === 'none' ? 'Commenting is disabled for this artifact' : 'Not authorized to comment',
      { errorCode: artifact.commentPolicy === 'none' ? 'comments_disabled' : 'forbidden' }
    );
  }

  // The legacy routes bypass the API-key rate-limit stack, so this window applies to every caller.
  // Admins are exempt.
  if (!user.isAdmin) {
    const recent = await Annotation.countDocuments({
      authorId: String(user.id),
      createdAt: { $gte: new Date(Date.now() - COMMENT_RATE_WINDOW_MS) },
    });
    if (recent >= COMMENT_RATE_MAX) {
      // The window counts across ALL artifacts, so the message must not blame this one.
      throw new TooManyRequestsError(
        'You have posted too many comments across your account recently - please slow down',
        { errorCode: 'comment_rate_limited' }
      );
    }
  }

  // Thread integrity: a reply must target a live annotation on the SAME artifact.
  if (input.threadRootId) {
    // A non-ObjectId can never name an annotation; checking first keeps it off the `_id` cast.
    const root = isValidObjectId(input.threadRootId)
      ? await Annotation.findOne({ _id: input.threadRootId, publicId, deletedAt: null })
          .select('_id')
          .lean<{ _id: unknown } | null>()
      : null;
    if (!root) {
      throw new BadRequestError('threadRootId does not reference an annotation on this artifact', {
        errorCode: 'invalid_thread_root',
      });
    }
  }

  const created = await Annotation.create({
    publicId,
    // Pin to the artifact's CURRENT version, not a client-supplied value.
    artifactVersionSha: artifact.sha256Index,
    kind: 'comment',
    authorId: String(user.id),
    authorDisplayName: authorDisplayName(user),
    body: input.body,
    anchor: input.anchor,
    threadRootId: input.threadRootId ?? null,
  });

  logger.info(`[ANNOTATE] create publicId=${publicId} by=${user.id} id=${created.id}`);
  return toAnnotationDto(created.toObject() as unknown as AnnotationLean);
}

export interface UpdateAnnotationInput extends AnnotationCaller {
  publicId: string;
  id: string;
  input: UpdateAnnotationRequest;
}

/** Edits an annotation's body (author only) and/or toggles its resolution (author, artifact owner or admin). */
export async function updateAnnotation({ user, publicId, id, input }: UpdateAnnotationInput): Promise<AnnotationDto> {
  if (!user?.id) throw authRequired();
  if (!publicId || !id) throw new BadRequestError('Missing publicId or id', { errorCode: 'missing_public_id' });

  const ann = await loadAnnotation(publicId, id);
  const userId = String(user.id);
  const isAdmin = Boolean(user.isAdmin);
  const isAuthor = ann.authorId === userId;

  if (input.body !== undefined) {
    // Editing the text is author-only - it's their words. Admins may resolve or delete, not reword.
    if (!isAuthor) {
      throw new ForbiddenError('Only the author may edit this annotation', { errorCode: 'author_only' });
    }
    ann.body = input.body;
  }
  if (input.resolved !== undefined) {
    const allowed = isAuthor || isAdmin || (await isArtifactOwner(publicId, userId));
    if (!allowed) {
      throw new ForbiddenError('Not authorized to resolve this annotation', { errorCode: 'forbidden' });
    }
    if (input.resolved) {
      ann.resolvedAt = new Date();
      ann.resolvedBy = userId;
    } else {
      ann.resolvedAt = null;
      ann.resolvedBy = null;
    }
  }

  await ann.save();
  return toAnnotationDto(ann.toObject() as unknown as AnnotationLean);
}

export interface DeleteAnnotationInput extends AnnotationCaller {
  publicId: string;
  id: string;
  logger: AnnotationLogger;
}

/** Soft-deletes an annotation (author, artifact owner or admin); the row stays as an audit trail. */
export async function deleteAnnotation({ user, publicId, id, logger }: DeleteAnnotationInput): Promise<void> {
  if (!user?.id) throw authRequired();
  if (!publicId || !id) throw new BadRequestError('Missing publicId or id', { errorCode: 'missing_public_id' });

  const ann = await loadAnnotation(publicId, id);
  const userId = String(user.id);
  const allowed = ann.authorId === userId || Boolean(user.isAdmin) || (await isArtifactOwner(publicId, userId));
  if (!allowed) {
    throw new ForbiddenError('Not authorized to delete this annotation', { errorCode: 'forbidden' });
  }

  await ann.softDelete(userId);
  logger.info(`[ANNOTATE] delete publicId=${publicId} id=${id} by=${userId}`);
}
