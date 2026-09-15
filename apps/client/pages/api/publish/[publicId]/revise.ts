import { baseApi } from '@server/middlewares/baseApi';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import { PublishedArtifact, Annotation } from '@bike4mind/database';
import type { IMessage, PublishScopeTier, PublishVisibility } from '@bike4mind/common';
import { validateBundle, buildPublishUrlPath, invalidatePublishCdn, toCacheTarget } from '@server/services/publish';
import { OperationsModelService } from '@client/services/operationsModelService';

/**
 * POST /api/publish/[publicId]/revise - Phase C of the artifact-collab layer:
 * close the loop by having an LLM revise a published bundle's index.html using
 * the open reviewer feedback, then land it as a new version.
 *
 * Owner/admin only. v1 is inline (owner clicks "AI Revise", waits) and revises
 * index.html ONLY - existing assets are preserved. The revised HTML is run back
 * through the SAME publish security contract (validateBundle) before it is
 * written, because LLM output is untrusted input. Consumed annotations are
 * marked resolved by `ai-revise`. The previous version's forensics are captured
 * in previousVersionMeta exactly like the human finalize path.
 *
 * Uses the in-monorepo LLM path (OperationsModelService + llm.complete
 * accumulation) - no external /chat round-trip, no API key.
 */

/** Cap the input HTML so the revised output can't silently truncate. */
const MAX_REVISE_INDEX_BYTES = 80 * 1024;
const REVISE_MAX_OUTPUT_TOKENS = 16000;
/** A revised doc shorter than this fraction of the original is treated as
 *  truncated/garbage and rejected rather than allowed to clobber a good version. */
const REVISE_MIN_OUTPUT_RATIO = 0.5;
/** A held revise lock older than this is considered stale and may be stolen. */
const REVISE_LOCK_TTL_MS = 180_000;

interface ReviseArtifactLean {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  title: string;
  visibility: PublishVisibility;
  ownerId: string;
  lastPublishedBy?: string;
  storageKeyPrefix: string;
  sha256Index?: string;
  size: { totalBytes: number; fileCount: number };
  manifest: Array<{ path: string; size: number; mimeType: string; sha256: string }>;
  publishedAt: Date;
  source: { kind: 'bundle' | 'reply' | 'fabfile' };
  versions?: Array<{ sha256Index: string }>;
}

interface OpenAnnotationLean {
  body: string;
  authorDisplayName: string;
  anchor?: { x?: number; y?: number };
}

/** Strip a leading/trailing markdown code fence the model may emit despite instructions. */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = /^```[a-z]*\s*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

function buildPrompt(html: string, annotations: OpenAnnotationLean[]): IMessage[] {
  const feedback = annotations
    .map(a => {
      const where =
        typeof a.anchor?.x === 'number' && typeof a.anchor?.y === 'number'
          ? `[pinned at ${Math.round(a.anchor.x * 100)}%, ${Math.round(a.anchor.y * 100)}%] `
          : '';
      return `- ${where}${a.authorDisplayName}: ${a.body}`;
    })
    .join('\n');

  return [
    {
      role: 'system',
      content:
        'You revise a single standalone HTML document based on reviewer feedback. ' +
        'Apply every piece of feedback faithfully while preserving the page’s structure, ' +
        'styling, and intent. Do not add external scripts or new asset files. ' +
        'Output ONLY the complete revised HTML document beginning with <!doctype html> — ' +
        'no markdown code fences, no explanations, no commentary before or after.',
    },
    {
      role: 'user',
      content: `# Current HTML\n${html}\n\n# Reviewer feedback (apply all)\n${feedback}`,
    },
  ];
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

  const publicId = String((req.query as { publicId?: string }).publicId ?? '');
  if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null }).lean<ReviseArtifactLean>();
  if (!artifact) return res.status(404).json({ error: 'Not found' });

  // Owner/admin only.
  if (artifact.ownerId !== String(req.user.id) && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Only the owner may revise this artifact' });
  }
  // v1 revises hosted bundles only (reply/fabfile snapshots have no index.html).
  if (artifact.source.kind !== 'bundle') {
    return res.status(400).json({ error: 'Only bundle artifacts can be AI-revised' });
  }
  // A bundle must carry the version anchor - without it we cannot scope feedback
  // (or the resolve) to the current version, and would risk applying/resolving
  // comments across all versions. Bundles always have it post-finalize.
  const currentSha = artifact.sha256Index;
  if (!currentSha) {
    return res.status(409).json({ error: 'Artifact has no version anchor yet; cannot revise' });
  }

  // ── Acquire a per-artifact revise lock atomically (steal if stale). ──
  const lockNow = new Date();
  const lockAcquired = await PublishedArtifact.findOneAndUpdate(
    {
      publicId,
      deletedAt: null,
      $or: [{ revisingAt: null }, { revisingAt: { $lt: new Date(lockNow.getTime() - REVISE_LOCK_TTL_MS) } }],
    },
    { $set: { revisingAt: lockNow } }
  );
  if (!lockAcquired) {
    return res.status(409).json({ error: 'A revision is already in progress for this artifact' });
  }

  try {
    // Gather the open feedback pinned to the CURRENT version.
    const open = await Annotation.find({ publicId, deletedAt: null, resolvedAt: null, artifactVersionSha: currentSha })
      .sort({ createdAt: 1 })
      .select('body authorDisplayName anchor')
      .lean<OpenAnnotationLean[]>();

    if (!open.length) {
      return res.status(400).json({ error: 'No open feedback to apply on the current version' });
    }

    const storage = getPublishedArtifactsStorage();
    let currentHtml: string;
    try {
      const buf = await storage.download(`${artifact.storageKeyPrefix}index.html`);
      if (buf.length > MAX_REVISE_INDEX_BYTES) {
        return res.status(422).json({
          error: `index.html (${buf.length}B) is too large to AI-revise in this version (max ${MAX_REVISE_INDEX_BYTES}B)`,
        });
      }
      currentHtml = buf.toString('utf-8');
    } catch {
      return res.status(500).json({ error: 'Artifact index.html missing from storage' });
    }

    // ── Run the LLM (in-monorepo path; accumulate the non-streamed completion). ──
    const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();
    req.logger.info(`[REVISE] ${publicId} using ${modelInfo.name} (${modelInfo.backend}) on ${open.length} comments`);

    const messages = buildPrompt(currentHtml, open);
    const buffers: string[] = [];
    await llm.complete(
      modelId,
      messages,
      { stream: false, maxTokens: REVISE_MAX_OUTPUT_TOKENS, temperature: 0.4 },
      async (chunk: (string | null | undefined)[]) => {
        chunk.forEach((part, i) => {
          if (part == null) return;
          buffers[i] = (buffers[i] ?? '') + part;
        });
      }
    );
    let revisedHtml = stripFences(buffers.filter(Boolean).join(''));

    // Defense-in-depth: strip any author/LLM inline <script> at WRITE time (not
    // just serve time) so a stored bundle never carries executable inline JS,
    // even though validateBundle would pass benign inline scripts.
    if (/<script/i.test(revisedHtml)) {
      const $ = cheerio.load(revisedHtml);
      $('script:not([src])').remove();
      revisedHtml = $.html();
    }

    // Reject truncated / gutted output rather than clobber a good version.
    if (!revisedHtml || !/<html[\s>]/i.test(revisedHtml) || !/<\/html\s*>/i.test(revisedHtml)) {
      return res.status(502).json({ error: 'The model did not return a complete HTML document' });
    }
    if (revisedHtml.length < currentHtml.length * REVISE_MIN_OUTPUT_RATIO) {
      return res.status(502).json({ error: 'The revised document looks truncated; not applied' });
    }

    // ── Re-validate against the publish security contract (untrusted output). ──
    const validation = validateBundle({
      indexHtml: revisedHtml,
      manifest: artifact.manifest.map(f => ({ path: f.path, mimeType: f.mimeType })),
    });
    if (!validation.valid) {
      return res.status(422).json({ error: 'Revised HTML failed validation', violations: validation.violations });
    }

    // Preserve the current version's CONTENT before overwriting so a bad
    // revision can be rolled back (previousVersionMeta only stores metadata).
    await storage
      .upload(Buffer.from(currentHtml, 'utf-8'), `${artifact.storageKeyPrefix}versions/${currentSha}.html`, {
        ContentType: 'text/html',
      })
      .catch(() =>
        req.logger.warn(`[REVISE] ${publicId} failed to archive previous version ${currentSha.slice(0, 12)}`)
      );

    // ── Write the new index.html in place + recompute version metadata. ──
    const revisedBuf = Buffer.from(revisedHtml, 'utf-8');
    await storage.upload(revisedBuf, `${artifact.storageKeyPrefix}index.html`, { ContentType: 'text/html' });
    const newIndexSha = createHash('sha256').update(revisedBuf).digest('hex');

    const newManifest = artifact.manifest.map(f =>
      f.path === 'index.html' ? { ...f, size: revisedBuf.length, sha256: newIndexSha } : f
    );
    const totalBytes = newManifest.reduce((sum, f) => sum + f.size, 0);
    const now = new Date();

    // Record the version, deduped by content sha and backfilling the version being
    // replaced if history doesn't yet contain it (see restore.ts for rationale).
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
    if (!haveShas.has(newIndexSha)) {
      versionsToPush.push({
        publishedAt: now,
        publishedBy: String(req.user.id),
        size: { totalBytes, fileCount: newManifest.length },
        sha256Index: newIndexSha,
      });
    }

    await PublishedArtifact.updateOne(
      { publicId, deletedAt: null },
      {
        $set: {
          manifest: newManifest,
          sha256Index: newIndexSha,
          size: { totalBytes, fileCount: newManifest.length },
          lastPublishedBy: String(req.user.id),
          publishedAt: now,
          previousVersionMeta: {
            publishedAt: artifact.publishedAt,
            publishedBy: artifact.lastPublishedBy ?? artifact.ownerId,
            size: artifact.size,
            sha256Index: currentSha,
          },
        },
        $push: { versions: { $each: versionsToPush } },
      }
    );

    // Mark the consumed feedback resolved by the AI revision (current version only).
    await Annotation.updateMany(
      { publicId, deletedAt: null, resolvedAt: null, artifactVersionSha: currentSha },
      { $set: { resolvedAt: now, resolvedBy: 'ai-revise' } }
    );

    // The new version overwrote index.html in place - bust the CDN cache so the
    // revision is visible immediately, not after the TTL. Only public pages are
    // CDN-cached (gated are no-store). Best-effort, never throws.
    if (artifact.visibility === 'public') void invalidatePublishCdn(toCacheTarget(artifact), req.logger);

    const url = buildPublishUrlPath(artifact.tier, artifact.scopeId, artifact.slug);
    req.logger.info(`[REVISE] ${publicId} → new version sha=${newIndexSha.slice(0, 12)} applied=${open.length}`);

    return res.status(200).json({
      publicId,
      url,
      sha256Index: newIndexSha,
      previousSha256Index: currentSha,
      commentsApplied: open.length,
      publishedAt: now.toISOString(),
      model: modelInfo.name,
    });
  } finally {
    // Compare-and-set release: only clear the lock if we still hold it. A request
    // whose lock was stolen after the TTL must NOT clear the newer holder's lock.
    await PublishedArtifact.updateOne({ publicId, revisingAt: lockNow }, { $set: { revisingAt: null } }).catch(
      () => undefined
    );
  }
});

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } },
};

export default handler;
