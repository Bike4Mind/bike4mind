import { baseApi } from '@server/middlewares/baseApi';
import { createHash } from 'node:crypto';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import { PublishedArtifact } from '@bike4mind/database';
import type { PublishScopeTier, PublishVisibility } from '@bike4mind/common';
import { validateBundle, buildPublishUrlPath, invalidatePublishCdn, toCacheTarget } from '@server/services/publish';

/**
 * POST /api/publish/[publicId]/restore[?sha={version}] - roll a published bundle
 * back to a prior version (the given known version, or the immediately-previous
 * by default).
 *
 * Owner/admin only. Reads the archived `versions/{sha}.html` blob (the
 * revise/restore paths archive the prior index.html before overwriting), and
 * writes it back as a NEW current version - archiving the version it replaces
 * first, so a restore is itself reversible. Re-validates through validateBundle.
 * Only restores `index.html` (assets are unchanged by revise/restore).
 *
 * 400 if there is no previous version; 409 if the previous content was never
 * archived (it predates the version-history feature). Shares the `revisingAt`
 * lock with revise so the two can't race.
 */

const RESTORE_LOCK_TTL_MS = 180_000;

interface RestoreArtifactLean {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  visibility: PublishVisibility;
  ownerId: string;
  lastPublishedBy?: string;
  storageKeyPrefix: string;
  sha256Index?: string;
  size: { totalBytes: number; fileCount: number };
  manifest: Array<{ path: string; size: number; mimeType: string; sha256: string }>;
  publishedAt: Date;
  source: { kind: 'bundle' | 'reply' | 'fabfile' };
  previousVersionMeta?: { sha256Index: string };
  versions?: Array<{ sha256Index: string }>;
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

  const publicId = String((req.query as { publicId?: string }).publicId ?? '');
  if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null }).lean<RestoreArtifactLean>();
  if (!artifact) return res.status(404).json({ error: 'Not found' });

  if (artifact.ownerId !== String(req.user.id) && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the owner may restore this artifact' });
  }
  if (artifact.source.kind !== 'bundle') {
    return res.status(400).json({ error: 'Only bundle artifacts can be restored' });
  }
  const currentSha = artifact.sha256Index;
  if (!currentSha) return res.status(409).json({ error: 'Artifact has no version anchor yet' });
  // `?sha={version}` restores a SPECIFIC archived version (must be a known prior
  // version, not the current one); without it, default to the immediately-previous.
  const requested = typeof (req.query as { sha?: string }).sha === 'string' ? (req.query as { sha: string }).sha : '';
  if (requested && (requested === currentSha || !(artifact.versions ?? []).some(v => v.sha256Index === requested))) {
    return res.status(400).json({ error: 'Requested version is not a known prior version of this artifact' });
  }
  const targetSha = requested || artifact.previousVersionMeta?.sha256Index;
  if (!targetSha) return res.status(400).json({ error: 'No previous version to restore' });

  // Acquire the shared revise/restore lock (steal if stale).
  const lockNow = new Date();
  const lockAcquired = await PublishedArtifact.findOneAndUpdate(
    {
      publicId,
      deletedAt: null,
      $or: [{ revisingAt: null }, { revisingAt: { $lt: new Date(lockNow.getTime() - RESTORE_LOCK_TTL_MS) } }],
    },
    { $set: { revisingAt: lockNow } }
  );
  if (!lockAcquired) {
    return res.status(409).json({ error: 'A revision or restore is already in progress for this artifact' });
  }

  try {
    const storage = getPublishedArtifactsStorage();

    // Read the archived previous version.
    let restoredHtml: string;
    try {
      restoredHtml = (await storage.download(`${artifact.storageKeyPrefix}versions/${targetSha}.html`)).toString(
        'utf-8'
      );
    } catch {
      // The version is known (validated above) but its archived blob is missing -
      // either it predates version history, or the archive write failed.
      return res.status(409).json({ error: "The requested version's content is unavailable in storage" });
    }

    // Re-validate (it was valid when current, but never trust storage blindly).
    const validation = validateBundle({
      indexHtml: restoredHtml,
      manifest: artifact.manifest.map(f => ({ path: f.path, mimeType: f.mimeType })),
    });
    if (!validation.valid) {
      return res.status(422).json({ error: 'Archived version failed validation', violations: validation.violations });
    }

    // Archive the CURRENT index.html before overwriting, so restore is reversible.
    try {
      const currentBuf = await storage.download(`${artifact.storageKeyPrefix}index.html`);
      await storage.upload(currentBuf, `${artifact.storageKeyPrefix}versions/${currentSha}.html`, {
        ContentType: 'text/html',
      });
    } catch {
      req.logger.warn(`[RESTORE] ${publicId} could not archive current version ${currentSha.slice(0, 12)}`);
    }

    // Write the restored version as the new current.
    const restoredBuf = Buffer.from(restoredHtml, 'utf-8');
    await storage.upload(restoredBuf, `${artifact.storageKeyPrefix}index.html`, { ContentType: 'text/html' });
    const newSha = createHash('sha256').update(restoredBuf).digest('hex');

    const newManifest = artifact.manifest.map(f =>
      f.path === 'index.html' ? { ...f, size: restoredBuf.length, sha256: newSha } : f
    );
    const totalBytes = newManifest.reduce((sum, f) => sum + f.size, 0);
    const now = new Date();

    // versions[] is keyed by content sha (distinct snapshots). Restoring old bytes
    // reproduces an existing sha, so we must NOT push a duplicate (it would corrupt
    // the switcher's ordinal math + the ?v/restore "not current" guards). Also
    // backfill the version being replaced if history doesn't yet record it
    // (pre-version-history artifacts, or the first revise/restore).
    const haveShas = new Set((artifact.versions ?? []).map(v => v.sha256Index));
    const versionsToPush: Array<{
      publishedAt: Date;
      publishedBy: string;
      size: typeof artifact.size;
      sha256Index: string;
    }> = [];
    if (!haveShas.has(currentSha)) {
      versionsToPush.push({
        publishedAt: artifact.publishedAt,
        publishedBy: artifact.lastPublishedBy ?? artifact.ownerId,
        size: artifact.size,
        sha256Index: currentSha,
      });
      haveShas.add(currentSha);
    }
    if (!haveShas.has(newSha)) {
      versionsToPush.push({
        publishedAt: now,
        publishedBy: String(req.user.id),
        size: { totalBytes, fileCount: newManifest.length },
        sha256Index: newSha,
      });
    }

    await PublishedArtifact.updateOne(
      { publicId, deletedAt: null },
      {
        $set: {
          manifest: newManifest,
          sha256Index: newSha,
          size: { totalBytes, fileCount: newManifest.length },
          lastPublishedBy: String(req.user.id),
          publishedAt: now,
          // The version we just replaced becomes the new "previous".
          previousVersionMeta: {
            publishedAt: artifact.publishedAt,
            publishedBy: artifact.lastPublishedBy ?? artifact.ownerId,
            size: artifact.size,
            sha256Index: currentSha,
          },
        },
        // $each:[] is a harmless no-op when nothing new to record.
        $push: { versions: { $each: versionsToPush } },
      }
    );

    // Restore overwrote index.html in place - bust the CDN so the rolled-back
    // version is visible immediately, not after the TTL. Only public pages are
    // CDN-cached (gated are no-store). Best-effort, never throws.
    if (artifact.visibility === 'public') void invalidatePublishCdn(toCacheTarget(artifact), req.logger);

    const url = buildPublishUrlPath(artifact.tier, artifact.scopeId, artifact.slug);
    req.logger.info(`[RESTORE] ${publicId} → restored ${targetSha.slice(0, 12)} as new version ${newSha.slice(0, 12)}`);

    return res.status(200).json({
      publicId,
      url,
      sha256Index: newSha,
      restoredFrom: targetSha,
      previousSha256Index: currentSha,
      publishedAt: now.toISOString(),
    });
  } finally {
    // Compare-and-set release: only clear the lock if we still hold it (a lock
    // stolen after the TTL belongs to a newer request).
    await PublishedArtifact.updateOne({ publicId, revisingAt: lockNow }, { $set: { revisingAt: null } }).catch(
      () => undefined
    );
  }
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
