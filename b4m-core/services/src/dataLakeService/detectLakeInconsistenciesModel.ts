import {
  EVIDENCE_MAX,
  normalizeSubject,
  type IDataLakeDocument,
  type IFabFileChunkRepository,
  type IFabFileRepository,
  type InconsistencyFinding,
} from '@bike4mind/common';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import {
  LakeContradictionReadingService,
  type ContradictionCandidateDocument,
} from '../llm/LakeContradictionReadingService';
import { Logger } from '@bike4mind/observability';
import { lakeMembershipScope } from './lakeMembershipScope';

/**
 * How many members are read per run. Well below the lexical pass's `INCONSISTENCY_MEMBER_SAMPLE`
 * (200) on purpose: this pass reads through an LLM, so its cost scales with both documents AND
 * chars-per-document, where the lexical pass's only costs a regex pass over whatever it reads.
 * Owner-triggered, same as the lexical pass - never on every health read.
 */
export const MODEL_INCONSISTENCY_MEMBER_SAMPLE = 60;
/**
 * Chunks read per member, from the START of the document - 4x the lexical pass's
 * `INCONSISTENCY_CHUNKS_PER_MEMBER` (5). The whole reason this pass exists is to read MORE deeply
 * than a 5-chunk window, so it deliberately trades member count for depth per member rather than
 * mirroring the lexical pass's shape.
 */
export const MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER = 20;
/** Chars of joined chunk text sent to the model per document, capping one huge file's own cost. */
export const MODEL_INCONSISTENCY_DOC_CHARS = 6_000;
/**
 * Documents compared per LLM call. A contradiction can only be found BETWEEN documents in the same
 * batch - two documents in different batches that actually disagree are invisible to this pass.
 * That is a real, honest limitation (the lexical pass has its own analog in `sampled`/`memberSampled`),
 * traded deliberately for cost: one call per `MODEL_INCONSISTENCY_MEMBER_SAMPLE` documents would
 * read as much text but risk a single oversized, slow, all-or-nothing request; this bounds a call's
 * cost and lets one bad batch fail without losing the rest of the run.
 */
export const MODEL_INCONSISTENCY_BATCH_SIZE = 15;
/** Abort the run once this many batches fail BACK-TO-BACK - the same systemic-failure guard as
 * `extractLakeMemoryForBatch`'s `MAX_CONSECUTIVE_DOC_FAILURES`, scaled to this pass's unit of work. */
export const MODEL_INCONSISTENCY_MAX_BATCH_FAILURES = 3;
/**
 * Findings kept per run. Only one kind is possible here (`narrative-contradiction`), so unlike the
 * lexical cap this needs no per-kind allocation - a plain slice is enough. A run that finds more
 * than this from a `MODEL_INCONSISTENCY_MEMBER_SAMPLE`-document sample is far more likely producing
 * noise than genuine signal, so the cap also functions as a quality floor.
 */
export const MODEL_INCONSISTENCY_FINDINGS_CAP = 100;

export interface DetectLakeInconsistenciesModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeMembershipMembers'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findChunkTextSample'>;
  };
  apiKeyTable: ApiKeyTable;
  /** Lake owner, threaded through to the LLM call for provider abuse attribution. */
  endUserId?: string;
  logger?: Logger;
}

export interface ModelInconsistencyResult {
  findings: InconsistencyFinding[];
  /** Documents actually read (yielded text), mirroring `LakeInconsistencyReport.memberCount`. */
  memberCount: number;
  /** True when the lake has more members than this pass sampled. */
  memberSampled: boolean;
  batchesRun: number;
  /** Batches whose LLM call failed outright (network, parse, validation) - not "found nothing". */
  batchesFailed: number;
  /** True when `MODEL_INCONSISTENCY_FINDINGS_CAP` dropped findings. */
  truncated: boolean;
}

/**
 * Read a lake's documents through an LLM to find the contradictions no pattern rule can see (#3057) -
 * the reading half of corpus-inconsistency detection, alongside the pure lexical rules
 * `detectLakeInconsistencies` runs. Same emission target: findings are shaped as
 * `InconsistencyFinding[]`, so a caller passes them straight to `recordLakeFindings` with
 * `detector: 'model'`.
 *
 * DETECTION ONLY (#2242). Nothing here rejects, gates or edits anything - see the guardrail on
 * `corpusInconsistency.ts` and `LakeContradictionReadingService`.
 *
 * Deliberately NOT a drop-in replacement for the lexical pass: it samples fewer members but reads
 * each one more deeply, compares documents only WITHIN a batch, and costs real money per run - see
 * each constant's own comment for the specific trade being made.
 */
export async function detectLakeInconsistenciesModel(
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db, apiKeyTable, endUserId, logger }: DetectLakeInconsistenciesModelAdapters
): Promise<ModelInconsistencyResult> {
  const empty = (memberSampled: boolean): ModelInconsistencyResult => ({
    findings: [],
    memberCount: 0,
    memberSampled,
    batchesRun: 0,
    batchesFailed: 0,
    truncated: false,
  });

  // Same guard as the lexical pass's: an absent datalakeTag would degrade the membership match to
  // "files with no tags" across every tenant, and this reads document TEXT.
  if (!lake.datalakeTag) return empty(false);

  const members = await db.fabFiles.findDataLakeMembershipMembers(
    lakeMembershipScope(lake),
    MODEL_INCONSISTENCY_MEMBER_SAMPLE
  );
  const memberSampled = members.length > MODEL_INCONSISTENCY_MEMBER_SAMPLE;
  const scanned = memberSampled ? members.slice(0, MODEL_INCONSISTENCY_MEMBER_SAMPLE) : members;
  if (memberSampled) {
    logger?.warn?.(
      `[lakeInconsistencyModel] lake ${lake.id} exceeds ${MODEL_INCONSISTENCY_MEMBER_SAMPLE} members; the model ` +
        `pass ran over the first ${MODEL_INCONSISTENCY_MEMBER_SAMPLE}. See result.memberSampled.`
    );
  }

  const documents: ContradictionCandidateDocument[] = [];
  for (const member of scanned) {
    try {
      const texts = await db.fabFileChunks.findChunkTextSample(member.fabFileId, MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER);
      const text = texts.join('\n').slice(0, MODEL_INCONSISTENCY_DOC_CHARS);
      // A member with no chunk text contributes nothing and would only cost the batch it landed in.
      if (text) documents.push({ fabFileId: member.fabFileId, fileName: member.fileName ?? null, text });
    } catch (error) {
      // Per-member catch, same isolation as the lexical pass: one unreadable file costs only itself.
      logger?.warn?.(
        `[lakeInconsistencyModel] lake ${lake.id}: could not read chunk text for ${member.fabFileId}: ${error}`
      );
    }
  }

  if (documents.length < 2) return { ...empty(memberSampled), memberCount: documents.length };

  const reader = new LakeContradictionReadingService(logger ?? new Logger());
  const findings: InconsistencyFinding[] = [];
  let batchesRun = 0;
  let batchesFailed = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < documents.length; i += MODEL_INCONSISTENCY_BATCH_SIZE) {
    const batch = documents.slice(i, i + MODEL_INCONSISTENCY_BATCH_SIZE);
    batchesRun += 1;
    const contradictions = await reader.evaluate({ apiKeyTable, documents: batch, endUserId });

    if (contradictions === null) {
      batchesFailed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= MODEL_INCONSISTENCY_MAX_BATCH_FAILURES) {
        logger?.error?.(
          `[lakeInconsistencyModel] lake ${lake.id}: ${consecutiveFailures} batches failed back-to-back; ` +
            `aborting the run rather than continuing to spend against a systemic failure.`
        );
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    const byId = new Map(batch.map(doc => [doc.fabFileId, doc]));
    for (const contradiction of contradictions) {
      findings.push({
        kind: 'narrative-contradiction',
        subject: normalizeSubject(contradiction.subject),
        evidence: contradiction.documents.slice(0, EVIDENCE_MAX).map(source => ({
          fabFileId: source.fabFileId,
          fileName: byId.get(source.fabFileId)?.fileName ?? null,
          excerpt: source.excerpt,
        })),
        documentCount: contradiction.documents.length,
      });
    }
  }

  const truncated = findings.length > MODEL_INCONSISTENCY_FINDINGS_CAP;
  return {
    findings: truncated ? findings.slice(0, MODEL_INCONSISTENCY_FINDINGS_CAP) : findings,
    memberCount: documents.length,
    memberSampled,
    batchesRun,
    batchesFailed,
    truncated,
  };
}
