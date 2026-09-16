import {
  detectCorpusInconsistencies,
  type LakeInconsistencyReport,
  type IDataLakeDocument,
  type IFabFileChunkRepository,
  type IFabFileRepository,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { lakeMembershipScope } from './lakeMembershipScope';

/**
 * How many members are sampled. Bounded because this reads CHUNK TEXT, which lake health is
 * explicitly forbidden from doing (#1665 measured a chunk-collection scan as ruinous at connector
 * scale) - so this runs as an owner-triggered pass over one lake, never on every health read, and
 * even then over a cap rather than the whole corpus.
 */
export const INCONSISTENCY_MEMBER_SAMPLE = 200;
/**
 * Chunks read per member, from the START of the document. Front-loaded on purpose: a superlative, a
 * headline metric and a relationship claim live in a document's opening rather than its appendices,
 * so the first few passages carry most of what these rules can find per byte read.
 */
export const INCONSISTENCY_CHUNKS_PER_MEMBER = 5;
/** Concurrent per-member chunk reads. Bounded so one lake's pass cannot saturate the pool. */
const CHUNK_READ_CONCURRENCY = 8;
/**
 * Findings persisted per lake. Lives here rather than in the route because the detector allocates it
 * per kind (`capPerKind`), which it can only do while it still holds every finding - a caller that
 * sliced the returned array afterwards would re-create the starvation the allocation exists to
 * prevent.
 */
export const INCONSISTENCY_FINDINGS_CAP = 200;

export interface DetectLakeInconsistenciesAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeMembershipMembers'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findChunkTextSample'>;
  };
  logger?: Logger;
}

/**
 * Detect cross-document inconsistencies in one lake (#2242).
 *
 * DETECTION ONLY - see `corpusInconsistency.ts`. Nothing here rejects or gates anything, and the
 * findings are heuristics over prose: each one means "worth a human's eye", never "proven
 * contradiction".
 *
 * `nowYear` is a parameter rather than a clock read so the same corpus produces the same report - a
 * stored result an owner already looked at has to be comparable to the next one.
 */
export async function detectLakeInconsistencies(
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  nowYear: number,
  { db, logger }: DetectLakeInconsistenciesAdapters
): Promise<LakeInconsistencyReport> {
  // Same guard as computeLakeHealth's: an absent datalakeTag would serialize to null in the
  // membership `$match` and degrade the query to "files with no tags" across every tenant - and this
  // returns document EXCERPTS. Report empty rather than ever scanning on a null tag.
  if (!lake.datalakeTag) {
    // Report nothing scanned rather than nothing found. `memberCount: 0` is what keeps a lake that
    // was never scanned from rendering as a clean one - the same non-null-means-clean confusion
    // lakeHealth warns about, which a fresh `computedAt` over an empty report would reintroduce.
    return {
      ...detectCorpusInconsistencies([], { nowYear, sampled: true }),
      memberSampled: false,
      memberCount: 0,
    };
  }

  const members = await db.fabFiles.findDataLakeMembershipMembers(
    lakeMembershipScope(lake),
    INCONSISTENCY_MEMBER_SAMPLE
  );
  const memberSampled = members.length > INCONSISTENCY_MEMBER_SAMPLE;
  const scanned = memberSampled ? members.slice(0, INCONSISTENCY_MEMBER_SAMPLE) : members;
  if (memberSampled) {
    logger?.warn?.(
      `[lakeInconsistency] lake ${lake.id} exceeds ${INCONSISTENCY_MEMBER_SAMPLE} members; detection ran ` +
        `over the first ${INCONSISTENCY_MEMBER_SAMPLE}. See report.memberSampled.`
    );
  }

  // Bounded fan-out. A per-member read rather than one `$in` across the lake: an aggregation that
  // pushed every chunk before applying a cap would hold the whole corpus in memory, which is the
  // opposite of what the bound is for.
  const documents: { fabFileId: string; fileName: string | null; text: string }[] = [];
  for (let i = 0; i < scanned.length; i += CHUNK_READ_CONCURRENCY) {
    const slice = scanned.slice(i, i + CHUNK_READ_CONCURRENCY);
    const texts = await Promise.all(
      slice.map(async member => {
        try {
          return await db.fabFileChunks.findChunkTextSample(member.fabFileId, INCONSISTENCY_CHUNKS_PER_MEMBER);
        } catch (error) {
          // Per-member catch: one unreadable file must cost only itself. This is a report, so a
          // partial answer is worth more than a failed request, and the omission is logged.
          logger?.warn?.(
            `[lakeInconsistency] lake ${lake.id}: could not read chunk text for ${member.fabFileId}: ${error}`
          );
          return [];
        }
      })
    );
    slice.forEach((member, index) => {
      const text = texts[index].join('\n');
      // A member with no chunk text contributes nothing and is dropped rather than carried as an
      // empty document, which would only add work to every rule.
      if (text) documents.push({ fabFileId: member.fabFileId, fileName: member.fileName ?? null, text });
    });
  }

  return {
    // `sampled` is TRUE on every run, and unconditionally so: this pass reads at most
    // INCONSISTENCY_CHUNKS_PER_MEMBER chunks from the start of each member, so it has never examined
    // a corpus whole and its counts are always a floor. It used to be derived from member overflow
    // alone, which told an owner of a small lake that the counts were exact about a pass that had
    // read five chunks per document. `memberSampled` carries the overflow case, which is the half
    // that is actionable - it means the lake outgrew the member cap.
    ...detectCorpusInconsistencies(documents, {
      nowYear,
      sampled: true,
      maxFindings: INCONSISTENCY_FINDINGS_CAP,
    }),
    memberSampled,
    memberCount: documents.length,
  };
}
