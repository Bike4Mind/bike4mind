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
import { CHUNK_READ_CONCURRENCY } from './detectLakeInconsistencies';
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
/**
 * Wall clock a single batch may need before the run refuses to start another one: the LLM call's
 * `SmallLLMService` timeout (30s) times its one retry, plus a margin for the findings write the
 * sink does afterwards. Checked BETWEEN batches, so this is what keeps a run from being killed
 * mid-call - the failure mode where the batch is billed and its findings are lost.
 */
export const MODEL_INCONSISTENCY_BATCH_BUDGET_MS = 70_000;

export interface DetectLakeInconsistenciesModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeMembershipMembers'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findChunkTextSample'>;
  };
  apiKeyTable: ApiKeyTable;
  /** Lake owner, threaded through to the LLM call for provider abuse attribution. */
  endUserId?: string;
  /**
   * Persist the findings from one batch, called after EACH batch rather than once at the end.
   *
   * The point is that spend and persistence advance together. Every batch costs real money the
   * moment it returns, so a run that dies afterwards - Lambda timeout, SQS redelivery, an unhandled
   * throw - must not discard what it already paid for. With this sink a killed run keeps every batch
   * that completed; without it the whole run is lost and the next attempt re-bills from zero.
   *
   * Errors are the caller's to absorb: a sink that throws is caught and counted here, because losing
   * one batch's rows is strictly better than losing the rest of the run with them. Kept as a callback
   * rather than moving the write inline so the detector stays free of a findings repository.
   */
  onBatchFindings?: (findings: InconsistencyFinding[]) => Promise<void>;
  /**
   * Remaining wall clock, in ms. Checked BETWEEN batches: a run stops cleanly when the next batch's
   * worst case would not fit, rather than being killed mid-call with the spend already incurred. The
   * queue handler passes the real Lambda clock; absent, the run is unbounded (tests, scripts).
   */
  getRemainingTimeInMillis?: () => number;
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
  /**
   * Batches that were read and billed but whose findings the sink could not persist. Distinct from
   * `batchesFailed` on purpose: that one means "we learned nothing", this one means "we learned
   * something and could not keep it", and only the second says a paid result was lost to a write.
   */
  batchesUnpersisted: number;
  /** Contradictions discarded because their subject normalized to the empty string. */
  subjectsDropped: number;
  /** True when the run stopped early on its wall-clock budget with documents still unread. */
  deadlineReached: boolean;
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
  {
    db,
    apiKeyTable,
    endUserId,
    onBatchFindings,
    getRemainingTimeInMillis,
    logger,
  }: DetectLakeInconsistenciesModelAdapters
): Promise<ModelInconsistencyResult> {
  const empty = (memberSampled: boolean): ModelInconsistencyResult => ({
    findings: [],
    memberCount: 0,
    memberSampled,
    batchesRun: 0,
    batchesFailed: 0,
    batchesUnpersisted: 0,
    subjectsDropped: 0,
    deadlineReached: false,
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

  // Bounded fan-out, the same shape and the same bound as the lexical pass. This one reads 4x the
  // chunks per member, so it has strictly more to gain from the concurrency and no reason to differ:
  // serialized, these are up to MODEL_INCONSISTENCY_MEMBER_SAMPLE round trips before the first LLM
  // call even starts.
  const documents: ContradictionCandidateDocument[] = [];
  for (let i = 0; i < scanned.length; i += CHUNK_READ_CONCURRENCY) {
    const slice = scanned.slice(i, i + CHUNK_READ_CONCURRENCY);
    const texts = await Promise.all(
      slice.map(async member => {
        try {
          return await db.fabFileChunks.findChunkTextSample(member.fabFileId, MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER);
        } catch (error) {
          // Per-member catch, same isolation as the lexical pass: one unreadable file costs only itself.
          logger?.warn?.(
            `[lakeInconsistencyModel] lake ${lake.id}: could not read chunk text for ${member.fabFileId}: ${error}`
          );
          return [];
        }
      })
    );
    slice.forEach((member, index) => {
      const text = texts[index].join('\n').slice(0, MODEL_INCONSISTENCY_DOC_CHARS);
      // A member with no chunk text contributes nothing and would only cost the batch it landed in.
      if (text) documents.push({ fabFileId: member.fabFileId, fileName: member.fileName ?? null, text });
    });
  }

  if (documents.length < 2) return { ...empty(memberSampled), memberCount: documents.length };

  const reader = new LakeContradictionReadingService(logger ?? new Logger());
  const findings: InconsistencyFinding[] = [];
  let batchesRun = 0;
  let batchesFailed = 0;
  let batchesUnpersisted = 0;
  let subjectsDropped = 0;
  let consecutiveFailures = 0;
  let deadlineReached = false;

  for (let i = 0; i < documents.length; i += MODEL_INCONSISTENCY_BATCH_SIZE) {
    // Between batches, never mid-call: starting a batch that cannot finish bills the call and throws
    // its findings away when the clock runs out. Stopping here keeps every batch already paid for and
    // reports the shortfall through `deadlineReached` instead of a timeout with nothing to show.
    if (getRemainingTimeInMillis && getRemainingTimeInMillis() < MODEL_INCONSISTENCY_BATCH_BUDGET_MS) {
      deadlineReached = true;
      logger?.warn?.(
        `[lakeInconsistencyModel] lake ${lake.id}: stopping after ${batchesRun} batches with ` +
          `${documents.length - i} documents unread; not enough wall clock left for another batch. ` +
          `See result.deadlineReached.`
      );
      break;
    }

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
    const batchFindings: InconsistencyFinding[] = [];
    for (const contradiction of contradictions) {
      const subject = normalizeSubject(contradiction.subject);
      // Drop rather than persist an empty subject. `subject` is part of the unique key
      // `recordLakeFindings` upserts on, so every finding that normalized to '' would collide onto a
      // SINGLE row per lake, each run silently overwriting the last one's sources. `normalizeSubject`
      // strips everything outside [a-z0-9\s%.-], so any subject in a non-Latin script or made only of
      // punctuation empties out - and this pass is the first to feed it arbitrary model free-text
      // rather than regex-matched tokens, which is what turns a latent exposure into a live one. The
      // schema's `required: true` does not catch it: the upsert runs without `runValidators`.
      if (!subject) {
        subjectsDropped += 1;
        logger?.warn?.(
          `[lakeInconsistencyModel] lake ${lake.id}: dropping a contradiction whose subject normalized ` +
            `to empty; keeping it would collapse every such finding onto one durable row.`
        );
        continue;
      }
      batchFindings.push({
        kind: 'narrative-contradiction',
        subject,
        evidence: contradiction.documents.slice(0, EVIDENCE_MAX).map(source => ({
          fabFileId: source.fabFileId,
          fileName: byId.get(source.fabFileId)?.fileName ?? null,
          excerpt: source.excerpt,
        })),
        documentCount: contradiction.documents.length,
      });
    }
    findings.push(...batchFindings);

    // Persist before the next batch, so the money this one cost survives whatever kills the run next.
    // Isolated: a write failure is logged and counted, never allowed to abort a run whose remaining
    // batches can still succeed - the same fail-soft posture as a failed batch read above.
    if (onBatchFindings && batchFindings.length > 0) {
      try {
        await onBatchFindings(batchFindings);
      } catch (error) {
        batchesUnpersisted += 1;
        logger?.error?.(
          `[lakeInconsistencyModel] lake ${lake.id}: could not persist ${batchFindings.length} findings ` +
            `from batch ${batchesRun}; the run continues and they remain in the returned result: ${error}`
        );
      }
    }
  }

  const truncated = findings.length > MODEL_INCONSISTENCY_FINDINGS_CAP;
  return {
    findings: truncated ? findings.slice(0, MODEL_INCONSISTENCY_FINDINGS_CAP) : findings,
    memberCount: documents.length,
    memberSampled,
    batchesRun,
    batchesFailed,
    batchesUnpersisted,
    subjectsDropped,
    deadlineReached,
    truncated,
  };
}
