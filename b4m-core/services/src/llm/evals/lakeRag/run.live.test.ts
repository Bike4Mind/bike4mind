/**
 * The live half of the lake RAG eval. Skips cleanly unless `LAKE_RAG_EVAL_BASE_URL`,
 * `LAKE_RAG_EVAL_MODEL` and a credential (`LAKE_RAG_EVAL_API_KEY` or `E2E_CLEANUP_SECRET`) are set,
 * so `pnpm turbo:test` stays deterministic. See README.md in this directory for how to run it.
 */
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveLakeRagAuth, type LakeRagAuth } from './auth';
import { loadLakeRagBank } from './bank';
import { readLakeRagCorpus } from './corpus';
import { provisionLakeRagLakes, type LakeRagApi, type LakeRagProvision } from './provision';
import { buildLakeRagReport, compareLakeRagReports, formatLakeRagReport } from './report';
import { readLakeRagReport, writeLakeRagReport } from './reportFile';
import { LAKE_RAG_ARMS, runLakeRagArms } from './run';

const baseUrl = process.env.LAKE_RAG_EVAL_BASE_URL;
const model = process.env.LAKE_RAG_EVAL_MODEL;
const apiKey = process.env.LAKE_RAG_EVAL_API_KEY;
const e2eCleanupSecret = process.env.E2E_CLEANUP_SECRET;
const samples = Number(process.env.LAKE_RAG_EVAL_SAMPLES ?? '1');
const reportPath = process.env.PROMPT_EVAL_REPORT_PATH;
const baselinePath = process.env.LAKE_RAG_EVAL_BASELINE_PATH;

const enabled = Boolean(baseUrl && model && (apiKey || e2eCleanupSecret));

if (enabled && (!Number.isInteger(samples) || samples < 1)) {
  throw new Error(`LAKE_RAG_EVAL_SAMPLES must be a positive integer, got: ${process.env.LAKE_RAG_EVAL_SAMPLES}`);
}

const rows = loadLakeRagBank();
const docs = readLakeRagCorpus(join(__dirname, 'corpus'));

// Budgets per sequential step (ms): an ingest covers upload, moderation and indexing; a turn covers
// one session, one chat and the quest poll.
const PER_INGEST_MS = 3 * 60 * 1000;
const PER_TURN_MS = 2 * 60 * 1000;
const TIMEOUT_MS = docs.length * PER_INGEST_MS + rows.length * LAKE_RAG_ARMS.length * samples * PER_TURN_MS;

describe.skipIf(!enabled)('lake RAG eval (live deployment)', () => {
  let auth: LakeRagAuth | undefined;
  let provision: LakeRagProvision | undefined;

  afterAll(async () => {
    const errors = (await provision?.teardown()) ?? [];
    // After the lakes: on the e2e path this deletes the user that owns them.
    const lakesDeleted = (await auth?.cleanup()) ?? 0;
    // On the e2e path the user cleanup deletes the user's lakes outright
    // (apps/client/pages/api/test/cleanup.ts), so a failed lake DELETE is covered once it reports them.
    const lakeCount = Object.keys(provision?.lakes ?? {}).length;
    if (auth?.source === 'e2e-user' && lakesDeleted >= lakeCount) return;
    expect(errors, 'teardown left eval lakes behind').toEqual([]);
  }, PER_INGEST_MS);

  it(
    'answers from the current document under the lake, multi-lake and plain arms',
    async () => {
      auth = await resolveLakeRagAuth({ baseUrl: baseUrl!, apiKey, e2eCleanupSecret });
      const api: LakeRagApi = { baseUrl: baseUrl!, authorization: auth.authorization };
      provision = await provisionLakeRagLakes(api, docs, { runId: Date.now().toString(36) });

      const turns = await runLakeRagArms(api, rows, provision.lakes, { model: model!, samples });
      const report = buildLakeRagReport(turns, { model: model!, samples });
      if (reportPath) writeLakeRagReport(reportPath, report);
      const comparison = baselinePath ? compareLakeRagReports(readLakeRagReport(baselinePath), report) : undefined;
      // stdout directly: vitest can drop console output from a passing test.
      process.stdout.write(`\n${formatLakeRagReport(report, comparison)}\n`);

      expect(comparison?.checks.filter(c => !c.ok).map(c => c.metric) ?? []).toEqual([]);
    },
    TIMEOUT_MS
  );
});
