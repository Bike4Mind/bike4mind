import {
  detectCorpusInconsistencies,
  type CorpusInconsistencyReport,
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
): Promise<CorpusInconsistencyReport> {
  // Same guard as computeLakeHealth's: an absent datalakeTag would serialize to null in the
  // membership `$match` and degrade the query to "files with no tags" across every tenant - and this
  // returns document EXCERPTS. Report empty rather than ever scanning on a null tag.
  if (!lake.datalakeTag) {
    return detectCorpusInconsistencies([], { nowYear });
  }

  const members = await db.fabFiles.findDataLakeMembershipMembers(
    lakeMembershipScope(lake),
    INCONSISTENCY_MEMBER_SAMPLE
  );
  const sampled = members.length > INCONSISTENCY_MEMBER_SAMPLE;
  const scanned = sampled ? members.slice(0, INCONSISTENCY_MEMBER_SAMPLE) : members;
  if (sampled) {
    logger?.warn?.(
      `[lakeInconsistency] lake ${lake.id} exceeds ${INCONSISTENCY_MEMBER_SAMPLE} members; detection ran ` +
        `over the first ${INCONSISTENCY_MEMBER_SAMPLE}. Findings are a lower bound - see report.sampled.`
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

  return detectCorpusInconsistencies(documents, { nowYear, sampled });
}
