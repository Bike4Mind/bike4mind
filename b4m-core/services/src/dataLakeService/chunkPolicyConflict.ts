import {
  FabFileChunkPolicyConflict,
  FabFileChunkPolicyConflictLake,
  IDataLakeDocument,
  IDataLakeRepository,
  IFabFileRepository,
  matchesTagPrefixArm,
} from '@bike4mind/common';
import { effectiveChunkTokenLimit } from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { extractDataLakeMetaTags, isStaticRegistryDatalakeTag } from './authorizeLakeWrite';

/**
 * Chunk-policy conflict detection and reporting (#1662, epic decision 7).
 *
 * Chunk policy is resolved at file-OWNER altitude (the scoped `DefaultChunkSize` setting), NOT owned
 * by any lake: chunks are keyed per FabFile and shared by every consumer of that file. A lake only
 * declares the policy it REQUIRES. When a file's chunks do not satisfy a lake it belongs to, that is
 * REPORTED here rather than silently re-chunked - re-chunking to satisfy one lake would rewrite the
 * shared chunks for non-members, and a file tagged into two lakes with disagreeing requirements
 * would oscillate (re-embedding, and billing, on every pass without ever converging).
 */

/** The file fields this module needs; a subset of IFabFile so callers can pass a lean object. */
export interface ChunkPolicyFile {
  id: string;
  userId: string;
  tags?: { name: string }[];
}

export interface ChunkPolicyConflictDb {
  dataLakes: Pick<IDataLakeRepository, 'find' | 'findByDatalakeTag'>;
  fabFiles: Pick<IFabFileRepository, 'setChunkPolicyConflict'>;
}

export interface RecomputeChunkPolicyAdapters {
  db: ChunkPolicyConflictDb;
  /** The embedding model both the file's and the lakes' effective targets are computed against. */
  embeddingModel: string;
  logger: Logger;
}

/**
 * Every DB-backed data lake a file currently belongs to, by BOTH membership signals: the
 * `datalake:*` meta-tag (resolved via findByDatalakeTag) and the owner-anchored prefix arm (a tag
 * under the lake's fileTagPrefix on a file its creator owns). Static-registry lakes are skipped -
 * they have no DB document and so cannot declare a required policy. Deduped by id. Touches the lakes
 * collection ZERO times for a file carrying no lake-membership signal (the common, non-lake case).
 */
export async function findMemberLakesForFile(
  file: ChunkPolicyFile,
  dataLakes: Pick<IDataLakeRepository, 'find' | 'findByDatalakeTag'>
): Promise<IDataLakeDocument[]> {
  const tagNames = (file.tags ?? []).map(t => t?.name).filter((n): n is string => typeof n === 'string');
  const byId = new Map<string, IDataLakeDocument>();

  const metaTags = extractDataLakeMetaTags(tagNames).filter(tag => !isStaticRegistryDatalakeTag(tag));
  const metaLakes = await Promise.all(metaTags.map(tag => dataLakes.findByDatalakeTag(tag)));
  for (const lake of metaLakes) if (lake) byId.set(lake.id, lake);

  // Prefix arm is owner-anchored; only query when a tag could carry one - every usable prefix ends
  // in ':' - so a non-lake file never touches the lakes collection for this arm.
  if (tagNames.some(name => name.includes(':'))) {
    const ownedLakes = await dataLakes.find({ createdByUserId: file.userId });
    for (const lake of ownedLakes) {
      if (byId.has(lake.id)) continue;
      if (matchesTagPrefixArm(tagNames, lake.fileTagPrefix)) byId.set(lake.id, lake);
    }
  }

  return [...byId.values()];
}

/**
 * Pure conflict decision: the member-lake requirements whose EFFECTIVE required target the file's
 * EFFECTIVE target does not equal. Comparing EFFECTIVE (post model-window clamp) targets on both
 * sides is deliberate - two configured values that both exceed the model window clamp to the same
 * limit and must NOT read as a conflict. No DB and no chunker here, so the decision is seam-testable
 * across all its shapes.
 */
export function findViolatedLakeRequirements(
  effectiveTarget: number,
  requirements: FabFileChunkPolicyConflictLake[]
): FabFileChunkPolicyConflictLake[] {
  return requirements.filter(requirement => requirement.effectiveRequiredTarget !== effectiveTarget);
}

/**
 * Build the effective requirement rows for a file's member lakes: only lakes that declare a
 * `requiredPassageTokenTarget`, each resolved through the same clamp the chunker applies so the
 * comparison is like-for-like. Pure given the lakes + model.
 */
export function buildLakeRequirements(
  lakes: readonly Pick<IDataLakeDocument, 'id' | 'name' | 'datalakeTag' | 'requiredPassageTokenTarget'>[],
  embeddingModel: string
): FabFileChunkPolicyConflictLake[] {
  return lakes
    .filter(lake => typeof lake.requiredPassageTokenTarget === 'number' && lake.requiredPassageTokenTarget > 0)
    .map(lake => {
      const requiredTarget = lake.requiredPassageTokenTarget as number;
      return {
        lakeId: lake.id,
        datalakeTag: lake.datalakeTag,
        name: lake.name,
        requiredTarget,
        effectiveRequiredTarget: effectiveChunkTokenLimit({
          model: embeddingModel,
          passageTokenTarget: requiredTarget,
        }),
      };
    });
}

/**
 * Recompute and persist a file's cross-lake chunk-policy conflict (#1662). Enumerates the file's
 * member lakes, compares its effective chunk target to each declaring lake's effective required
 * target, and records the violated lakes - or clears a now-resolved conflict. Always records the
 * effective target the chunks were built with so a later membership change can re-check WITHOUT
 * re-chunking. This function NEVER re-chunks: chunk policy is file-owner altitude and a lake is only
 * a constraint. Returns the conflict written (or null when there is none).
 *
 * `effectiveTarget` is the file's OWN effective chunk target (post model-window clamp). Callers pass
 * the value just used (the chunk handler) or the value previously recorded (a membership change).
 */
export async function recomputeFileChunkPolicyConflict(
  file: ChunkPolicyFile,
  effectiveTarget: number,
  { db, embeddingModel, logger }: RecomputeChunkPolicyAdapters
): Promise<FabFileChunkPolicyConflict | null> {
  const lakes = await findMemberLakesForFile(file, db.dataLakes);
  const requirements = buildLakeRequirements(lakes, embeddingModel);

  const violated = findViolatedLakeRequirements(effectiveTarget, requirements);
  const conflict: FabFileChunkPolicyConflict | null = violated.length
    ? { effectiveTarget, embeddingModel, lakes: violated, detectedAt: new Date() }
    : null;

  await db.fabFiles.setChunkPolicyConflict(file.id, effectiveTarget, conflict);

  if (conflict) {
    logger.warn(
      `[chunkPolicy] file ${file.id} chunk target ${effectiveTarget} conflicts with ${violated.length} lake requirement(s): ` +
        violated.map(v => `${v.name} requires ${v.effectiveRequiredTarget}`).join('; ')
    );
  } else if (requirements.length > 0) {
    // A satisfied requirement is worth a line so a smoke test can distinguish "checked, no conflict"
    // from "never checked" (the failure the epic's observability rule targets).
    logger.log(
      `[chunkPolicy] file ${file.id} satisfies all ${requirements.length} lake chunk requirement(s) at target ${effectiveTarget}`
    );
  }

  return conflict;
}
