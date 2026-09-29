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

const DUPLICATE_KEY = 11000;

type WriteErrorLike = { code?: unknown; err?: { code?: unknown } } | null;

/** True when every write error of an unordered bulk insert is a duplicate key. */
function onlyDuplicateKeys(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, writeErrors } = err as { code?: unknown; writeErrors?: unknown };
  if (!Array.isArray(writeErrors) || writeErrors.length === 0) return code === DUPLICATE_KEY;
  // Mongoose hands back { err, index } entries, with the server code on `err`.
  return writeErrors.every((e: WriteErrorLike) => (e?.code ?? e?.err?.code) === DUPLICATE_KEY);
}

/** Upserts the run by externalRunId (idempotency key) and replaces its test rows. Caller: pages/api/qa/runs.ts. */
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

  // Replace, never merge: a re-sent run is the new truth for its tests. Two concurrent ingests
  // of one run can interleave delete/insert; the unique { runId, testKey } index turns the second
  // insert into duplicate-key errors, which leave exactly one row per test.
  await QaTestResult.deleteMany({ runId });
  if (tests.length > 0) {
    try {
      await QaTestResult.insertMany(
        tests.map(t => ({ ...t, runId })),
        { ordered: false }
      );
    } catch (err) {
      if (!onlyDuplicateKeys(err)) throw err;
    }
  }
  return { runId, status, created: !result.lastErrorObject?.updatedExisting };
}
