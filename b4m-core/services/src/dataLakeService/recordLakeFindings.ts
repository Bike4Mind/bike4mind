import {
  LAKE_FINDING_SOURCE_MAX,
  type IDataLakeFindingRepository,
  type InconsistencyFinding,
  type LakeFindingDetector,
  type LakeFindingSource,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export interface RecordLakeFindingsAdapters {
  db: {
    dataLakeFindings: Pick<IDataLakeFindingRepository, 'recordDetected'>;
  };
  logger?: Logger;
}

export interface RecordLakeFindingsOptions {
  detector: LakeFindingDetector;
  /**
   * The run's clock. Passed in rather than read per finding so one run stamps all of its rows
   * identically - "everything this pass still saw" has to be a single instant to compare against.
   */
  seenAt: Date;
}

export interface RecordLakeFindingsResult {
  recorded: number;
  /** Findings whose upsert threw. Reported rather than swallowed; see the catch below. */
  failed: number;
}

/**
 * Persist one detection pass's findings as rows (#3039), creating each on first sight and updating
 * it on every sighting after that.
 *
 * DETECT, DO NOT REJECT (#2242). This writes rows and nothing else: no document is ingested,
 * re-chunked, removed or gated as a result of anything here, and a row's status is a human's word
 * about the corpus rather than an instruction to act on it.
 *
 * Takes findings rather than a `LakeInconsistencyReport` so the model-driven pass (#3057) can emit
 * into the same collection without first having to fabricate a lexical report's envelope. The
 * report-level flags (`sampled`, `truncated`, `memberCount`) describe the RUN, not any one problem,
 * so they belong with the run that reports them, not duplicated onto every row it wrote.
 */
export async function recordLakeFindings(
  lakeId: string,
  findings: InconsistencyFinding[],
  { detector, seenAt }: RecordLakeFindingsOptions,
  { db, logger }: RecordLakeFindingsAdapters
): Promise<RecordLakeFindingsResult> {
  let recorded = 0;
  let failed = 0;

  // Sequential, and bounded upstream by INCONSISTENCY_FINDINGS_CAP: the pass that produces these
  // has already done ~1000 chunk reads, so the cost that matters is not this loop's latency but the
  // write concurrency it would add to a collection every other lake is also being scanned against.
  for (const finding of findings) {
    try {
      await db.dataLakeFindings.recordDetected({
        lakeId,
        kind: finding.kind,
        subject: finding.subject,
        detector,
        sources: toSources(finding),
        documentCount: finding.documentCount,
        seenAt,
      });
      recorded += 1;
    } catch (error) {
      // Isolated per finding, the same way the detector isolates a per-member read failure: one
      // malformed subject must not cost a curator the other 199 problems this pass found. Counted
      // and returned rather than swallowed, so a caller reports a partial write as partial.
      failed += 1;
      logger?.error('Failed to record lake finding', {
        lakeId,
        detector,
        kind: finding.kind,
        subject: finding.subject,
        error,
      });
    }
  }

  return { recorded, failed };
}

/**
 * The detector already caps evidence at its own EVIDENCE_MAX, so this cap is normally a no-op. It
 * is applied anyway because this function is the write door for every producer, including #3057's,
 * and the stored row's size must not depend on a caller having remembered the same bound.
 */
const toSources = (finding: InconsistencyFinding): LakeFindingSource[] =>
  finding.evidence.slice(0, LAKE_FINDING_SOURCE_MAX).map(({ fabFileId, fileName, excerpt }) => ({
    fabFileId,
    fileName,
    excerpt,
  }));
