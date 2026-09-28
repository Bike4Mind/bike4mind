import { QaRun, QaTestResult } from '@bike4mind/database';
import { deriveRunStatus, qaObjectPrefix, type QaRunInput, type QaRunStatus } from '@bike4mind/common';
import { UnprocessableEntityError } from '@server/utils/errors';

export interface IngestRunResult {
  runId: string;
  status: QaRunStatus;
  created: boolean;
}

/** One ingest key can serve several products, so keys are pinned to the payload's own run prefix. */
export function assertArtifactScope(input: QaRunInput): void {
  const report = qaObjectPrefix(input.product, input.externalRunId, 'report');
  if (input.reportPrefix !== undefined && input.reportPrefix !== report) {
    throw new UnprocessableEntityError(`report_prefix must be ${report}`);
  }
  const media = qaObjectPrefix(input.product, input.externalRunId, 'media');
  for (const test of input.tests) {
    for (const artifact of test.artifacts) {
      if (!artifact.key.startsWith(media) || artifact.key.includes('..')) {
        throw new UnprocessableEntityError(`artifact key is outside this run: ${artifact.key}`);
      }
    }
  }
}

const withoutUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Upserts the run by externalRunId (idempotency key) and replaces its test rows. Caller: pages/api/v1/qa/runs.ts. */
export async function ingestRun(input: QaRunInput): Promise<IngestRunResult> {
  assertArtifactScope(input);
  const status = deriveRunStatus(input.counts);
  const { tests, ...run } = input;

  const result = await QaRun.findOneAndUpdate(
    { externalRunId: input.externalRunId },
    { $set: withoutUndefined({ ...run, startedAt: new Date(run.startedAt), status }) },
    { upsert: true, new: true, includeResultMetadata: true, runValidators: true, setDefaultsOnInsert: true }
  );
  const doc = result.value;
  if (!doc) throw new Error('QaRun upsert returned no document');
  const runId = String(doc._id);

  // Replace, never merge: a re-sent run is the new truth for its tests.
  await QaTestResult.deleteMany({ runId });
  if (tests.length > 0) {
    await QaTestResult.insertMany(
      tests.map(t => ({ ...t, runId })),
      { ordered: false }
    );
  }
  return { runId, status, created: !result.lastErrorObject?.updatedExisting };
}
