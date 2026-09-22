import {
  EVIDENCE_MAX,
  inconsistencyFindingKey,
  normalizeSubject,
  type IDataLakeDocument,
  type IDataLakeFindingRepository,
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
 * The four constants below are ONE budget, not four independent knobs, and they are tuned together
 * against a single binding constraint: the handler's 10-minute Lambda timeout (infra/queues.ts).
 *
 *   members x doc-chars      = text read per run
 *   ceil(members / batch)    = LLM calls per run
 *   batch x doc-chars        = prompt chars per call
 *   calls x batch-budget-ms  = wall clock per run, which must fit 10 minutes
 *
 * Today: 40 x 24,000 = 960,000 chars read, over ceil(40 / 8) = 5 calls of 192,000 prompt chars
 * (~48k tokens on the ~4 chars/token average `chunking.ts` documents for English prose), at up to
 * {@link MODEL_INCONSISTENCY_BATCH_BUDGET_MS} each = 500s worst case inside a 600s Lambda.
 *
 * Raising any one of them without re-deriving the rest is what produced the defect these numbers
 * replace: a 20-chunk read whose 6,000-char cap discarded seventeen of the twenty chunks, leaving
 * the paid pass reading 60% of what the free lexical pass reads.
 */

/**
 * How many members are read per run. Well below the lexical pass's `INCONSISTENCY_MEMBER_SAMPLE`
 * (200) on purpose: this pass reads through an LLM, so its cost scales with both documents AND
 * chars-per-document, where the lexical pass's only costs a regex pass over whatever it reads.
 * This is the breadth half of the trade - see `MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER` for the depth
 * it is spent on. Owner-triggered, same as the lexical pass - never on every health read.
 */
export const MODEL_INCONSISTENCY_MEMBER_SAMPLE = 40;
/**
 * Chunks read per member, from the START of the document - 2.4x the lexical pass's
 * `INCONSISTENCY_CHUNKS_PER_MEMBER` (5). The whole reason this pass exists is to read MORE deeply
 * than a 5-chunk window, so it deliberately trades member count for depth per member rather than
 * mirroring the lexical pass's shape.
 *
 * This number only means anything if {@link MODEL_INCONSISTENCY_DOC_CHARS} can actually hold it:
 * chunks target `DEFAULT_PASSAGE_TOKEN_TARGET` (512) tokens, so ~2,048 chars each, and 12 of them
 * is ~24,576 chars. The two MUST be moved together or the cap silently overrides this constant.
 */
export const MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER = 12;
/**
 * Chars of joined chunk text sent to the model per document. Sized to ADMIT
 * {@link MODEL_INCONSISTENCY_CHUNKS_PER_MEMBER} full-size chunks rather than to bound them, so it
 * acts as a safety stop for an abnormally large chunk instead of as the real depth limit - which is
 * what it had become. For reference, the lexical pass reads its 5 chunks uncapped, ~10,240 chars, so
 * this is ~2.3x that window: the pass now reads deeper per document than the one it supplements,
 * which is the only thing that justifies its cost.
 */
export const MODEL_INCONSISTENCY_DOC_CHARS = 24_000;
/**
 * Documents compared per LLM call. A contradiction can only be found BETWEEN documents in the same
 * batch - two documents in different batches that actually disagree are invisible to this pass.
 * That is a real, honest limitation (the lexical pass has its own analog in `sampled`/`memberSampled`),
 * traded deliberately for cost: one call per `MODEL_INCONSISTENCY_MEMBER_SAMPLE` documents would
 * read as much text but risk a single oversized, slow, all-or-nothing request; this bounds a call's
 * cost and lets one bad batch fail without losing the rest of the run.
 *
 * Lowered alongside the depth raise above: with 4x the chars per document, the previous 15 would
 * have put ~360k prompt chars into a single call, well past what one `MODEL_CONTRADICTION_TIMEOUT_MS`
 * window can return.
 */
export const MODEL_INCONSISTENCY_BATCH_SIZE = 8;
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
 * Wall clock a single batch may need before the run refuses to start another one:
 * `MODEL_CONTRADICTION_TIMEOUT_MS` (45s) times its one retry, plus a margin for the findings write
 * the sink does afterwards. Checked BETWEEN batches, so this is what keeps a run from being killed
 * mid-call - the failure mode where the batch is billed and its findings are lost. Derived from that
 * timeout, so raising one without the other reintroduces exactly that failure.
 */
export const MODEL_INCONSISTENCY_BATCH_BUDGET_MS = 100_000;

/**
 * This pass is the `model` detector. Named here rather than at the call site for the same reason
 * `INCONSISTENCY_DETECTOR` is: the dismissal lookup below and the row write the caller performs
 * afterwards have to agree on it, or the suppression keys on one detector, the rows on another, and
 * a dismissal silently never matches.
 */
export const MODEL_INCONSISTENCY_DETECTOR = 'model' as const;

export interface DetectLakeInconsistenciesModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeMembershipMembers'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'findChunkTextSample'>;
    dataLakeFindings: Pick<IDataLakeFindingRepository, 'listDismissedKeys'>;
  };
  apiKeyTable: ApiKeyTable;
  /** Lake owner, threaded through to the LLM call for provider abuse attribution. */
  endUserId?: string;
  /**
   * Persist the findings one batch created or CHANGED, called after EACH batch rather than once at
   * the end. Findings are deduped by `kind+subject` across the whole run, so a batch that names a
   * subject an earlier batch already found hands over the MERGED finding, not that batch's raw view
   * of it - the sink upserts on that same key, and passing the raw view would have the later write
   * replace the earlier one's evidence.
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
  /** Contradictions discarded because a curator has already dismissed that kind+subject. */
  dismissedSuppressed: number;
  /**
   * Contradictions that folded into a finding this run had already produced, rather than minting a
   * second one. Non-zero means the model named the same disagreement more than once - expected from
   * free text, and the reason the merge below exists.
   */
  subjectsMerged: number;
  /** True when the run stopped early on its wall-clock budget with documents still unread. */
  deadlineReached: boolean;
  /**
   * True when `MODEL_INCONSISTENCY_FINDINGS_CAP` refused a contradiction. The cap is applied as
   * findings are admitted, not to the returned array, so this means a finding was never written -
   * not that one was written and hidden from the response.
   */
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
    dismissedSuppressed: 0,
    subjectsMerged: 0,
    deadlineReached: false,
    truncated: false,
  });

  // Same guard as the lexical pass's: an absent datalakeTag would degrade the membership match to
  // "files with no tags" across every tenant, and this reads document TEXT.
  if (!lake.datalakeTag) return empty(false);

  // Loaded before the run, mirroring the lexical pass. Suppression here cannot save the LLM call that
  // re-derives a dismissed contradiction - the model decides what it finds - but it stops a curator's
  // ruling being re-reported every run, and stops re-derived findings consuming slots against
  // `MODEL_INCONSISTENCY_FINDINGS_CAP` that a genuinely new contradiction would otherwise get. On a
  // heavily-curated lake that is most of the run's budget spent on answers already rejected.
  //
  // TOLERATED, not required, for the same reason as the lexical pass's: a transient failure here must
  // not cost a run that would otherwise have succeeded, and this one has already been paid for by the
  // time findings exist. Failing open re-reports a dismissal for one run; failing closed throws away
  // the run.
  let dismissed: ReadonlySet<string> = new Set();
  try {
    dismissed = new Set(
      (await db.dataLakeFindings.listDismissedKeys(lake.id, MODEL_INCONSISTENCY_DETECTOR)).map(k =>
        inconsistencyFindingKey(k.kind, k.subject)
      )
    );
  } catch (error) {
    logger?.warn?.(
      `[lakeInconsistencyModel] lake ${lake.id}: could not read dismissed findings; running without ` +
        `suppression, so previously dismissed findings will be reported again: ${error}`
    );
  }

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
  /**
   * Findings keyed by `inconsistencyFindingKey(kind, subject)` - the SAME identity
   * `recordLakeFindings` upserts on. A Map rather than an array because two contradictions that
   * normalize to one subject are one durable row, not two: the upsert `$set`s sources, so pushing
   * both would have the second silently replace the first's evidence, and a model returning free
   * text collides far more often than the lexical pass's bounded vocabulary. Insertion order is
   * preserved, so the returned array keeps the order findings were discovered in.
   */
  const findingsByKey = new Map<string, { finding: InconsistencyFinding; documentIds: Set<string> }>();
  let batchesRun = 0;
  let batchesFailed = 0;
  let batchesUnpersisted = 0;
  let subjectsDropped = 0;
  let dismissedSuppressed = 0;
  let subjectsMerged = 0;
  let truncated = false;
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
    // The findings this batch created or changed, by identity - so a batch that names one subject
    // twice persists it once. Persisting the MERGED finding rather than the raw batch output is what
    // keeps the durable row consistent with the returned one when a later batch names a subject an
    // earlier batch already found.
    const touched = new Set<InconsistencyFinding>();
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
      const key = inconsistencyFindingKey('narrative-contradiction', subject);

      // A curator has already ruled on this one. Dropped rather than reported: `recordDetected` writes
      // `status` only under `$setOnInsert`, so re-detection could never reopen the row - what would be
      // lost is the suppression itself, plus a cap slot a new contradiction should have had.
      if (dismissed.has(key)) {
        dismissedSuppressed += 1;
        continue;
      }

      const existing = findingsByKey.get(key);
      if (!existing) {
        // The cap bounds what is WRITTEN, not just what is returned. Enforced here, before the row
        // exists, because `onBatchFindings` fires per batch and a cap applied to the returned array
        // at the end would let four chatty batches persist far more rows than it claims to allow.
        if (findingsByKey.size >= MODEL_INCONSISTENCY_FINDINGS_CAP) {
          truncated = true;
          continue;
        }
        const finding: InconsistencyFinding = {
          kind: 'narrative-contradiction',
          subject,
          evidence: contradiction.documents.slice(0, EVIDENCE_MAX).map(source => ({
            fabFileId: source.fabFileId,
            fileName: byId.get(source.fabFileId)?.fileName ?? null,
            excerpt: source.excerpt,
          })),
          documentCount: contradiction.documents.length,
        };
        findingsByKey.set(key, {
          finding,
          documentIds: new Set(contradiction.documents.map(source => source.fabFileId)),
        });
        touched.add(finding);
        continue;
      }

      // Same subject seen again: merge rather than mint or overwrite. Evidence grows to EVIDENCE_MAX
      // with documents not already cited; `documentCount` counts the DISTINCT documents the merged
      // finding spans, which is why the id set is tracked separately - it must stay honest past the
      // point evidence stops growing.
      subjectsMerged += 1;
      for (const source of contradiction.documents) {
        if (existing.documentIds.has(source.fabFileId)) continue;
        existing.documentIds.add(source.fabFileId);
        if (existing.finding.evidence.length < EVIDENCE_MAX) {
          existing.finding.evidence.push({
            fabFileId: source.fabFileId,
            fileName: byId.get(source.fabFileId)?.fileName ?? null,
            excerpt: source.excerpt,
          });
        }
      }
      existing.finding.documentCount = existing.documentIds.size;
      touched.add(existing.finding);
    }

    // Persist before the next batch, so the money this one cost survives whatever kills the run next.
    // Isolated: a write failure is logged and counted, never allowed to abort a run whose remaining
    // batches can still succeed - the same fail-soft posture as a failed batch read above.
    const batchFindings = Array.from(touched);
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

  // No slice here: the cap is enforced as findings are admitted above, so what was returned and what
  // was written are the same set. `truncated` says a contradiction was refused, not merely hidden.
  return {
    findings: Array.from(findingsByKey.values(), entry => entry.finding),
    memberCount: documents.length,
    memberSampled,
    batchesRun,
    batchesFailed,
    batchesUnpersisted,
    subjectsDropped,
    dismissedSuppressed,
    subjectsMerged,
    deadlineReached,
    truncated,
  };
}
