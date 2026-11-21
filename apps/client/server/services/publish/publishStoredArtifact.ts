import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  PUBLISH_LIMITS,
  SlugSchema,
  requireEnv,
  type ArtifactFile,
  type ArtifactType,
  type PublishAccessGateRequest,
  type PublishVisibility,
  type ValidationViolation,
} from '@bike4mind/common';
import { PublishedArtifact, liveShareTokens, type PublishedArtifactShareToken } from '@bike4mind/database';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { deletePublishThumbnails, enqueuePublishThumbnail } from '@bike4mind/server-utils/utils/publishThumbnails';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/server-utils/utils/errors';
import { buildPublishS3KeyPrefix, buildPublishUrlPath } from '@bike4mind/server-utils/services/publish/paths';
import {
  downloadPublishedIndex,
  deleteRetiredPublishedIndex,
  publishedContentSnapshotFilter,
} from '@bike4mind/server-utils/services/publish/currentIndex';
import { validateBundle } from '@bike4mind/server-utils/services/publish/validateBundle';
import { invalidatePublishCdn, toCacheTarget } from '@bike4mind/server-utils/services/publish/invalidatePublishCdn';
import { assertPublicationPublicLink } from './organizationPolicy';
import { planVersionedPublish, versionsPushUpdate } from './planPublishVersions';
import { consumePublishAction } from './publishRateLimit';
import { renderArtifactIndexHtml } from './renderArtifactHtml';
import { resolveVisibility } from './resolveVisibility';
import {
  buildReactArtifactBundle,
  ReactArtifactTranspileError,
  UnsupportedReactDependencyError,
} from './transpileReactArtifact';
import type { PublishUser } from './checkScopePermission';

/**
 * Publishes a STORED artifact as a page: the server reads the content, renders it with the same
 * renderer `finalize` uses, and writes the page and its record in one call, with the access gate set
 * in the same write as the visibility. Backs the public `/api/v1/artifacts/{id}/publish` family;
 * the web app keeps the upload-url -> PUT -> finalize flow and its canonical object writes.
 *
 * Only the user tier is reachable from here: the page lives at `user/<ownerId>/<slug>`, and the
 * stored artifact's owner is the only caller allowed to publish it.
 */

type PublishLogger = NonNullable<Parameters<typeof invalidatePublishCdn>[1]>;

export interface StoredArtifactToPublish {
  id: string;
  type: ArtifactType;
  title: string;
  /** The artifact's current version, reported back as the version the page shows. */
  version: number;
}

type Publisher = PublishUser & { createdAt?: Date | string | null };

interface PublishCommon {
  user: Publisher;
  artifact: StoredArtifactToPublish;
  content: string;
  logger: PublishLogger;
}

export interface PublishedPage {
  publicId: string;
  slug: string;
  /** Relative path of the page; join it to the app origin with {@link absolutePublishUrl}. */
  path: string;
  visibility: PublishVisibility;
  accessGateKind: 'passphrase' | 'domain' | null;
  publishedVersion: number;
  publishedAt: Date;
}

type StoredAccessGate = { kind: 'passphrase'; passphraseHash: string } | { kind: 'domain'; allowedDomains: string[] };

interface PreviousPage {
  publicId: string;
  slug: string;
  publishedAt: Date;
  ownerId: string;
  lastPublishedBy?: string;
  visibility: PublishVisibility;
  size: { totalBytes: number; fileCount: number };
  sha256Index?: string;
  storageKeyPrefix: string;
  indexObjectPath?: string | null;
  versions?: Array<{ sha256Index: string; indexBytes?: number }>;
  shareTokens?: PublishedArtifactShareToken[];
}

// Keep in sync with DOMAIN_RE in pages/api/publish/artifacts/[id].ts, which gates the same field.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function absolutePublishUrl(path: string): string {
  return `${requireEnv('APP_URL', process.env.APP_URL).trim().replace(/\/+$/, '')}${path}`;
}

// The suffix is derived from the artifact id, not random: two concurrent publishes of one artifact without a
// slug then target the same slug, so the unique index turns the loser into a 409 instead of a second page.
function slugFromTitle(title: string, artifactId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${base.length >= 3 ? base : 'page'}-${createHash('sha256').update(artifactId).digest('hex').slice(0, 6)}`;
}

function violation(type: ValidationViolation['type'], message: string): UnprocessableEntityError {
  return new UnprocessableEntityError('Validation failed', {
    violations: [{ type, message, file: 'index.html' }],
  });
}

/** Renders the artifact to the final `index.html` bytes and validates them, as finalize does. */
async function renderPage(artifact: StoredArtifactToPublish, content: string) {
  let html: string;
  if (artifact.type === 'react') {
    try {
      html = (await buildReactArtifactBundle({ source: content, title: artifact.title })).indexHtml;
    } catch (err) {
      if (err instanceof UnsupportedReactDependencyError || err instanceof ReactArtifactTranspileError) {
        throw violation('forbidden_pattern', err.message);
      }
      throw err;
    }
  } else {
    html = renderArtifactIndexHtml(artifact.type, content, artifact.title);
  }

  const buffer = Buffer.from(html, 'utf-8');
  if (buffer.length > PUBLISH_LIMITS.maxFileBytes) {
    throw violation('size_exceeded', `index.html (${buffer.length}B) exceeds per-file limit`);
  }
  const validation = validateBundle({
    indexHtml: html,
    manifest: [{ path: 'index.html', mimeType: 'text/html' }],
  });
  if (!validation.valid) {
    throw new UnprocessableEntityError('Validation failed', { violations: validation.violations });
  }
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

async function buildAccessGate(gate: PublishAccessGateRequest): Promise<StoredAccessGate> {
  if (gate.kind === 'passphrase') {
    return { kind: 'passphrase', passphraseHash: await bcrypt.hash(gate.passphrase, 10) };
  }
  const entries = gate.allowed_domains.map(d => d.trim().toLowerCase());
  // Each entry must be a real registrable domain and is stored as entered, never reduced: reducing
  // `acme.onmicrosoft.com` to the shared `onmicrosoft.com` would admit every other tenant.
  if (entries.some(d => !DOMAIN_RE.test(d) || registrableDomain(d, { allowPrivateDomains: true }) === null)) {
    throw new UnprocessableEntityError(
      'Each allowed domain must be a registrable domain (e.g. acme.com or a specific subdomain), not a public suffix like co.uk'
    );
  }
  return { kind: 'domain', allowedDomains: [...new Set(entries)] };
}

function findPreviousPage(artifactId: string, userId: string) {
  return PublishedArtifact.findOne({
    'source.artifactId': artifactId,
    ownerId: userId,
    tier: 'user',
    scopeId: userId,
    deletedAt: null,
  })
    .select(
      'publicId slug publishedAt ownerId lastPublishedBy visibility size sha256Index storageKeyPrefix indexObjectPath versions shareTokens'
    )
    .lean<PreviousPage | null>();
}

/** Stages owned immutable bytes before an insert or exact-generation metadata switch. */
async function writePage(
  input: Omit<PublishCommon, 'content'> & {
    slug: string;
    previous: PreviousPage | null;
    settings: { visibility: PublishVisibility; accessGate: StoredAccessGate | null } | null;
    page: Awaited<ReturnType<typeof renderPage>>;
  }
): Promise<PublishedPage> {
  const { user, artifact, logger, slug, previous, settings, page } = input;
  const storage = getPublishedArtifactsStorage();
  const canonicalPrefix = buildPublishS3KeyPrefix('user', user.id, slug);
  const manifestFile: ArtifactFile = {
    path: 'index.html',
    size: page.buffer.length,
    mimeType: 'text/html',
    sha256: page.sha256,
  };

  // Archive the exact previous payload; a concurrent canonical write cannot become the wrong version.
  const priorIndex = previous?.sha256Index
    ? await downloadPublishedIndex({ ...previous, storageKeyPrefix: canonicalPrefix }, storage)
    : null;
  if (priorIndex && createHash('sha256').update(priorIndex).digest('hex') !== previous?.sha256Index) {
    throw new ConflictError('The published page changed. Reload it before republishing.');
  }

  const now = new Date();
  const { versionsToPush, quota } = await planVersionedPublish({
    previous,
    priorIndex,
    incoming: {
      sha256: page.sha256,
      publishedBy: user.id,
      publishedAt: now,
      size: { totalBytes: page.buffer.length, fileCount: 1 },
      indexBytes: page.buffer.length,
    },
    quota: {
      ownerId: user.id,
      orgScopeId: null,
      isAdmin: user.isAdmin,
      replacing: { tier: 'user', scopeId: user.id, slug },
    },
  });
  if (!quota.ok) {
    throw new BadRequestError(quota.error, { errorCode: 'storage_limit_exceeded' });
  }

  const action = await consumePublishAction({ id: user.id, isAdmin: user.isAdmin, createdAt: user.createdAt });
  const indexObjectPath = `revisions/${randomUUID()}/index.html`;
  const indexKey = `${canonicalPrefix}${indexObjectPath}`;
  const publicId = previous?.publicId ?? randomUUID().replace(/-/g, '').slice(0, 12);
  let commitState: 'not_attempted' | 'unknown' | 'committed' = 'not_attempted';
  try {
    if (previous?.sha256Index && priorIndex) {
      await storage.upload(priorIndex, `${canonicalPrefix}versions/${previous.sha256Index}.html`, {
        ContentType: 'text/html',
      });
    }
    await storage.upload(page.buffer, indexKey, { ContentType: 'text/html' });
    const fields = {
      publicId,
      title: artifact.title,
      ownerId: user.id,
      lastPublishedBy: user.id,
      source: { kind: 'bundle', artifactId: artifact.id, artifactType: artifact.type },
      storageKeyPrefix: canonicalPrefix,
      indexObjectPath,
      size: { totalBytes: page.buffer.length, fileCount: 1 },
      sha256Index: page.sha256,
      manifest: [manifestFile],
      publishedAt: now,
      previousVersionMeta: previous
        ? {
            publishedAt: previous.publishedAt,
            publishedBy: previous.lastPublishedBy ?? previous.ownerId,
            size: previous.size,
            sha256Index: previous.sha256Index ?? '',
          }
        : undefined,
      // Visibility and gate are written together and only on the first publish: a republish
      // keeps whatever the owner has since set on the page.
      ...(settings
        ? {
            visibility: settings.visibility,
            commentPolicy: 'none',
            ...(settings.accessGate ? { accessGate: settings.accessGate } : {}),
          }
        : {}),
    };
    commitState = 'unknown';
    const saved = previous
      ? await PublishedArtifact.findOneAndUpdate(
          {
            publicId: previous.publicId,
            tier: 'user',
            scopeId: user.id,
            slug,
            deletedAt: null,
            ownerId: user.id,
            'source.artifactId': artifact.id,
            ...publishedContentSnapshotFilter(previous),
            revisingAt: null,
          },
          { $set: fields, ...versionsPushUpdate(versionsToPush) },
          { upsert: false, new: true, runValidators: true }
        )
      : await PublishedArtifact.create({
          ...fields,
          v1ArtifactId: artifact.id,
          tier: 'user',
          scopeId: user.id,
          slug,
          versions: versionsToPush,
        });
    if (!saved) {
      commitState = 'not_attempted';
      throw new ConflictError('The published page changed or is being revised. Reload it before republishing.');
    }
    commitState = 'committed';
    if (previous && priorIndex) {
      await deleteRetiredPublishedIndex({ ...previous, storageKeyPrefix: canonicalPrefix }, storage, error => {
        logger.warn(
          `[PUBLISH] ${publicId} could not remove a retired page payload: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }

    // A public page is CDN-cached, so a republish must purge the prior copy.
    if (saved.visibility === 'public' || previous?.visibility === 'public') {
      await invalidatePublishCdn(toCacheTarget(saved), logger);
    }
    await enqueuePublishThumbnail({ publicId: saved.publicId, versionId: page.sha256 }, logger);

    logger.info(
      `[PUBLISH] v1 ${previous ? 'republish' : 'publish'} artifact=${artifact.id} ${slug} user=${user.id} bytes=${page.buffer.length}`
    );
    return {
      publicId: saved.publicId,
      slug,
      path: buildPublishUrlPath('user', user.id, slug),
      visibility: saved.visibility as PublishVisibility,
      accessGateKind: saved.accessGate?.kind ?? null,
      publishedVersion: artifact.version,
      publishedAt: now,
    };
  } catch (error) {
    if (
      commitState === 'unknown' &&
      (isDuplicateKeyError(error) ||
        error instanceof mongoose.Error.ValidationError ||
        error instanceof mongoose.Error.CastError)
    )
      commitState = 'not_attempted';
    if (commitState === 'not_attempted') {
      await action.refund();
      await storage.delete(indexKey).catch((cleanupError: unknown) => {
        logger.warn(
          `[PUBLISH] ${publicId} could not remove an uncommitted page payload: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      });
    } else if (commitState === 'unknown') {
      // A lost acknowledgement can follow a committed write; its payload and counted action must survive.
      logger.warn(`[PUBLISH] ${publicId} metadata write is unconfirmed; retaining its payload and counted action`);
    }
    if (isDuplicateKeyError(error)) throw new ConflictError('This artifact or slug was published by another request');
    throw error;
  }
}

export async function publishStoredArtifact(
  input: PublishCommon & {
    slug?: string;
    visibility: PublishVisibility;
    accessGate?: PublishAccessGateRequest;
  }
): Promise<PublishedPage> {
  const { user, artifact, content, logger } = input;

  let slug: string;
  if (input.slug === undefined) {
    slug = slugFromTitle(artifact.title, artifact.id);
  } else {
    const parsed = SlugSchema.safeParse(input.slug);
    if (!parsed.success) {
      throw new UnprocessableEntityError(parsed.error.issues[0]?.message ?? 'Invalid slug');
    }
    slug = parsed.data;
  }

  if (input.accessGate && input.visibility !== 'public') {
    throw new UnprocessableEntityError('An access gate requires `visibility: "public"`');
  }
  const viz = resolveVisibility('user', input.visibility);
  if (!viz.ok) throw new UnprocessableEntityError(viz.error);
  const accessGate = input.accessGate ? await buildAccessGate(input.accessGate) : null;

  if (viz.visibility === 'public') {
    await assertPublicationPublicLink({ tier: 'user', scopeId: user.id, source: { artifactId: artifact.id } });
  }

  const [previous, slugTaken] = await Promise.all([
    findPreviousPage(artifact.id, user.id),
    PublishedArtifact.exists({ tier: 'user', scopeId: user.id, slug, deletedAt: null }),
  ]);
  if (previous) {
    throw new ConflictError('This artifact already has a page. Republish it, or unpublish it first.');
  }
  if (slugTaken) {
    throw new ConflictError('This slug is used by another of your pages');
  }

  const page = await renderPage(artifact, content);
  return writePage({
    user,
    artifact,
    logger,
    slug,
    previous: null,
    settings: { visibility: viz.visibility, accessGate },
    page,
  });
}

export async function republishStoredArtifact(input: PublishCommon): Promise<PublishedPage> {
  const { user, artifact } = input;
  const previous = await findPreviousPage(artifact.id, user.id);
  if (!previous) throw new NotFoundError('Artifact is not published');
  // A republish can push new content to a page that is public or reachable through a live share link.
  if (previous.visibility === 'public' || liveShareTokens(previous).length > 0) {
    await assertPublicationPublicLink({ tier: 'user', scopeId: user.id, source: { artifactId: artifact.id } });
  }
  const page = await renderPage(artifact, input.content);
  return writePage({ ...input, slug: previous.slug, previous, settings: null, page });
}

export async function unpublishStoredArtifact(input: {
  user: PublishUser;
  artifactId: string;
  logger: PublishLogger;
}): Promise<void> {
  const { user, artifactId, logger } = input;
  const page = await PublishedArtifact.findOne({
    'source.artifactId': artifactId,
    ownerId: user.id,
    tier: 'user',
    scopeId: user.id,
    deletedAt: null,
  });
  if (!page) throw new NotFoundError('Artifact is not published');
  const wasPublic = page.visibility === 'public';
  await page.softDelete(user.id);
  // The CDN would otherwise keep serving a taken-down public page until its TTL.
  if (wasPublic) await invalidatePublishCdn(toCacheTarget(page), logger);
  await deletePublishThumbnails([page.publicId], logger);
}
