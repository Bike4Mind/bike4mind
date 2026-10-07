import path from 'path';
import type { Octokit } from '@octokit/rest';
import type { Logger } from '@bike4mind/observability';
import {
  adminSettingsRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  fabFileRepository,
} from '@bike4mind/database';
import {
  BATCH_NON_TERMINAL_STATUSES,
  DATALAKE_TAG_STRENGTH,
  FabFileSourceType,
  GITHUB_LAKE_FILE_RULES,
  KnowledgeType,
  type GitHubLakeTreeCounts,
  type IFabFileDocument,
  type IOrgGitHubLakeConnectionDocument,
  type IUserDocument,
} from '@bike4mind/common';
import { BadRequestError, checkStorageLimit, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { dataLakeService } from '@bike4mind/services';
import defineAbilitiesFor from '@server/auth/ability';
import { MAX_FILE_SIZE_DEFAULT_MB } from '@server/utils/maxFileSizeDefault';
import {
  getBlobBytes,
  getRecursiveTree,
  gitHubRateLimitDelaySeconds,
} from '@server/integrations/github/dataLake/lakeAppClient';
import {
  checkLakeFileContent,
  classifyTreeEntry,
  lakeFileMimeType,
  type GitHubLakeCandidate,
} from '@server/integrations/github/dataLake/lakeFileFilter';
import { diffGitHubLakeTree } from '@server/integrations/github/dataLake/githubLakeTreeDiff';
import {
  assertConnectorLakeWrite,
  createLakeIngestRetirer,
  ingestLakeFile,
  type IngestLake,
} from '@server/queueHandlers/lakeIngestShared';
import { v4 as uuidv4 } from 'uuid';

// Stop starting files with less than this left, so the invocation yields instead of dying mid-file.
export const GITHUB_LAKE_DEADLINE_BUFFER_MS = 90_000;

export type GitHubLakeSliceInput = {
  octokit: Octokit;
  repoFullName: string;
  commitSha: string;
  connection: IOrgGitHubLakeConnectionDocument;
  lake: IngestLake;
  user: IUserDocument;
  resumeBatchId?: string;
  remainingMs: () => number;
  /** Persists the tree read's split for the lake's source card; the caller holds the claim it is written under. */
  recordTreeCounts: (counts: GitHubLakeTreeCounts) => Promise<void>;
  logger: Logger;
};

export type GitHubLakeSliceOutcome =
  | { kind: 'done'; batchId: string | null; transientSkips: number }
  | { kind: 'refused'; batchId: string | null; message: string }
  | { kind: 'deadline'; batchId: string | null; remaining: number }
  | { kind: 'rate_limited'; batchId: string | null; delaySeconds: number; remaining: number };

/**
 * Mirrors driveLakeIngest.ts's apply order; throws on anything unclassified (incl. GitHub 404) for
 * the wrapping queue handler to interpret.
 */
export async function runGitHubLakeSlice(input: GitHubLakeSliceInput): Promise<GitHubLakeSliceOutcome> {
  const {
    octokit,
    repoFullName,
    commitSha,
    connection,
    lake,
    user,
    resumeBatchId,
    remainingMs,
    recordTreeCounts,
    logger,
  } = input;
  const priorBatchId = resumeBatchId ?? null;

  let tree: Awaited<ReturnType<typeof getRecursiveTree>>;
  try {
    tree = await getRecursiveTree(octokit, repoFullName, commitSha);
  } catch (error) {
    const delaySeconds = gitHubRateLimitDelaySeconds(error, Date.now());
    if (delaySeconds === null) throw error;
    return { kind: 'rate_limited', batchId: priorBatchId, delaySeconds, remaining: 0 };
  }
  if (tree.truncated) {
    return {
      kind: 'refused',
      batchId: priorBatchId,
      message: 'This repository is too large to sync: GitHub truncated its file listing.',
    };
  }

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const maxFileBytes = Math.min(
    GITHUB_LAKE_FILE_RULES.maxFileBytes,
    getSettingsValue('MaxFileSize', settings, MAX_FILE_SIZE_DEFAULT_MB) * 1024 * 1024
  );
  const oversized: { path: string; size: number }[] = [];
  let skippedCount = 0;
  const candidates = tree.entries.flatMap(entry => {
    const verdict = classifyTreeEntry(entry, maxFileBytes);
    if (verdict.ok) return [verdict.candidate];
    // Directories (and submodules) are tree entries, not files the rules turned away.
    if (verdict.reason !== 'not_blob') skippedCount += 1;
    if (verdict.reason === 'oversized' && entry.path) oversized.push({ path: entry.path, size: entry.size ?? 0 });
    return [];
  });
  await recordTreeCounts({ candidateCount: candidates.length, skippedCount });
  if (candidates.length > GITHUB_LAKE_FILE_RULES.maxCandidates) {
    return {
      kind: 'refused',
      batchId: priorBatchId,
      message: `This repository has ${candidates.length} ingestable files, over the ${GITHUB_LAKE_FILE_RULES.maxCandidates}-file limit for one sync.`,
    };
  }

  const existing = await fabFileRepository.findByGitHubConnectionIdInDataLake(connection.id, lake.datalakeTag);
  const diff = diffGitHubLakeTree(
    candidates,
    existing,
    oversized.map(entry => entry.path)
  );

  // A settled batch or one from another lake is not adopted; the chain starts a fresh one.
  const adoptedBatch = resumeBatchId
    ? await dataLakeBatchRepository
        .findById(resumeBatchId)
        .then(prior =>
          prior &&
          prior.dataLakeId === connection.targetDataLakeId &&
          BATCH_NON_TERMINAL_STATUSES.includes(prior.status)
            ? prior
            : null
        )
    : null;
  const skippedThisChain = new Set(adoptedBatch?.skippedDriveFileIds ?? []);
  const toIngest: { candidate: GitHubLakeCandidate; prior?: IFabFileDocument }[] = [
    ...diff.adds.map(candidate => ({ candidate })),
    ...diff.changed,
  ].filter(({ candidate }) => !skippedThisChain.has(candidate.path));
  // Oversized entries never reach the diff above (classifyTreeEntry drops them before it), so they
  // need the same per-chain de-dup toIngest applies, against the same skippedDriveFileIds.
  const newOversized = oversized.filter(({ path: p }) => !skippedThisChain.has(p));

  const membershipActor = { userId: connection.connectedBy, isAdmin: true };
  const retirer = createLakeIngestRetirer({
    lake,
    membershipActor,
    replacementOwnerId: connection.connectedBy,
    candidateOwnerIds: [connection.connectedBy, ...existing.map(doc => doc.userId)],
    logTag: '[githubLakeIngest]',
    logger,
  });
  let membershipChanged = false;
  const priorOrAdoptedBatchId = adoptedBatch?.id ?? priorBatchId;

  try {
    for (const [index, doc] of diff.removed.entries()) {
      // A removal is a full hard-delete, so a large removal set can outrun the deadline too; yielding
      // here (vs. a real Lambda kill skipping `finally`) keeps completed deletes' reclaim durable.
      if (remainingMs() < GITHUB_LAKE_DEADLINE_BUFFER_MS) {
        return { kind: 'deadline', batchId: priorOrAdoptedBatchId, remaining: diff.removed.length - index };
      }
      await retirer.retireSupersededCopy(doc, null);
      membershipChanged = true;
    }
    const duplicateRetires = diff.duplicates.flatMap(({ keep, retire }) =>
      retire.map(duplicate => ({ keep, duplicate }))
    );
    for (const [index, { keep, duplicate }] of duplicateRetires.entries()) {
      if (remainingMs() < GITHUB_LAKE_DEADLINE_BUFFER_MS) {
        return { kind: 'deadline', batchId: priorOrAdoptedBatchId, remaining: duplicateRetires.length - index };
      }
      await retirer.retireSupersededCopy(duplicate, keep.id);
      membershipChanged = true;
    }

    if (toIngest.length === 0) {
      // No batch this run to record them into (one isn't created for skips alone - see the loop
      // below), so a persistent oversized file doesn't churn a fresh batch on every no-op sync.
      if (newOversized.length > 0) {
        logger.info('[githubLakeIngest] oversized files with no other sync work this run; not recorded', {
          count: newOversized.length,
          examples: newOversized.slice(0, 5),
        });
      }
      return { kind: 'done', batchId: priorOrAdoptedBatchId, transientSkips: 0 };
    }

    try {
      await assertConnectorLakeWrite(lake, membershipActor, connection.connectedBy, logger);
    } catch (refusal) {
      if (!(refusal instanceof BadRequestError)) throw refusal;
      return { kind: 'refused', batchId: priorOrAdoptedBatchId, message: refusal.message };
    }

    const batch =
      adoptedBatch ??
      (await dataLakeBatchRepository.create({
        dataLakeId: connection.targetDataLakeId,
        userId: connection.connectedBy,
        status: 'processing',
        conflictResolution: 'skip',
        totalFiles: toIngest.length + newOversized.length,
        totalSizeBytes: toIngest.reduce((sum, { candidate }) => sum + candidate.size, 0),
        uploadedFiles: 0,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        processingFailedFiles: 0,
        skippedFiles: 0,
        deferredFiles: 0,
        uploadedSizeBytes: 0,
        files: [],
        appliedTags: [],
        startedAt: new Date(),
        wantsTaxonomy: false,
        taxonomyStatus: 'none',
      }));
    if (adoptedBatch) {
      // Raised, never lowered: settleLakeIngestBatch sets the exact total when the chain ends. Includes
      // newOversized: this run also skip-records those, and skippedFiles must not exceed totalFiles.
      const planned =
        (adoptedBatch.files?.length ?? 0) + (adoptedBatch.skippedFiles ?? 0) + toIngest.length + newOversized.length;
      if (planned > adoptedBatch.totalFiles)
        await dataLakeBatchRepository.setTotalFilesIfActive(adoptedBatch.id, planned);
    }

    const ability = defineAbilitiesFor(user);
    const applyFallbackTags = dataLakeService.createDataLakeFallbackTagger({
      db: { dataLakes: dataLakeRepository },
      logger,
    });
    let acceptedBytes = 0;
    let transientSkips = 0;
    const skip = async (githubPath: string, reason: string, extra?: Record<string, unknown>) => {
      await dataLakeBatchRepository.recordSkippedDriveFile(batch.id, githubPath);
      logger.info('[githubLakeIngest] skipping file', { githubPath, reason, ...extra });
    };

    // A tree entry over the size cap is filtered out before the diff above and so never becomes a
    // toIngest candidate; record it here (permanent, like the post-fetch skips below) or it silently
    // vanishes with no trace in the batch - mirrors driveLakeIngest.ts's own pre-fetch size skip.
    for (const { path: oversizedPath, size } of newOversized) {
      await skip(oversizedPath, 'oversized', { size });
    }

    for (const [index, { candidate, prior }] of toIngest.entries()) {
      if (remainingMs() < GITHUB_LAKE_DEADLINE_BUFFER_MS) {
        return { kind: 'deadline', batchId: batch.id, remaining: toIngest.length - index };
      }
      let bytes: Buffer;
      try {
        bytes = await getBlobBytes(octokit, repoFullName, candidate.sha);
      } catch (error) {
        const delaySeconds = gitHubRateLimitDelaySeconds(error, Date.now());
        if (delaySeconds === null) throw error;
        return { kind: 'rate_limited', batchId: batch.id, delaySeconds, remaining: toIngest.length - index };
      }
      if (bytes.length > maxFileBytes) {
        await skip(candidate.path, 'oversized_after_fetch', { size: bytes.length });
        continue;
      }
      const content = checkLakeFileContent(bytes);
      if (content !== 'ok') {
        await skip(candidate.path, content);
        continue;
      }
      try {
        await checkStorageLimit(user, Math.max(0, acceptedBytes + bytes.length - retirer.stagedReclaimFor(user.id)));
      } catch (error) {
        if (!(error instanceof BadRequestError)) throw error;
        // Not a chain skip: freeing space makes it ingestable, so later slices and the next sync retry it.
        transientSkips++;
        logger.info('[githubLakeIngest] storage limit reached; file left for the next sync', {
          githubPath: candidate.path,
        });
        continue;
      }

      const fileKey = `${uuidv4()}${path.posix.extname(candidate.path)}`;
      const tags = await applyFallbackTags([{ name: lake.datalakeTag, strength: DATALAKE_TAG_STRENGTH }]);
      const fabFile = await ingestLakeFile({
        data: {
          userId: connection.connectedBy,
          filePath: fileKey,
          fileSize: bytes.length,
          fileName: path.posix.basename(candidate.path),
          mimeType: lakeFileMimeType(candidate.path),
          type: KnowledgeType.FILE,
          tags,
          batchId: batch.id,
          relativePath: candidate.path,
          status: 'pending',
          sourceType: FabFileSourceType.GITHUB,
          sourceLakeId: connection.targetDataLakeId,
          githubConnectionId: connection.id,
          githubPath: candidate.path,
          githubBlobSha: candidate.sha,
        },
        ability,
        lake,
        membershipActor,
        batchId: batch.id,
        bytes,
        fileKey,
        logger,
      });
      acceptedBytes += bytes.length;
      if (prior) {
        await retirer.retireSupersededCopy(prior, fabFile.id);
        membershipChanged = true;
      }
    }
    return { kind: 'done', batchId: batch.id, transientSkips };
  } finally {
    await retirer.flushReclaimedStorage();
    if (membershipChanged) {
      await dataLakeService
        .recomputeLakeStats(lake, { db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository } })
        .catch(e =>
          logger.error('[githubLakeIngest] failed to recompute lake stats', {
            error: e instanceof Error ? e.message : String(e),
          })
        );
    }
  }
}
