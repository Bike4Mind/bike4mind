/**
 * The live half of the admin assistant eval. Skips cleanly unless `ADMIN_EVAL_BASE_URL`,
 * `ADMIN_EVAL_MODEL` and `E2E_CLEANUP_SECRET` are set, so `pnpm turbo:test` stays deterministic.
 * A measurement, not a gate: it never fails on its pass rate. See README.md in this directory.
 */
import { afterAll, describe, it } from 'vitest';
import { resolveLakeRagAuth, type LakeRagAuth } from '../lakeRag/auth';
import { MAX_429_WAIT_MS } from '../lakeRag/http';
import type { LakeRagApi } from '../lakeRag/provision';
import { ADMIN_EVAL_CASES, TARGET_CREDITS } from './cases';
import { buildAdminEvalReport, formatAdminEvalReport } from './report';
import { writeAdminEvalReport } from './reportFile';
import { runAdminEval } from './run';

const baseUrl = process.env.ADMIN_EVAL_BASE_URL;
const model = process.env.ADMIN_EVAL_MODEL;
const e2eCleanupSecret = process.env.E2E_CLEANUP_SECRET;
const samples = Number(process.env.ADMIN_EVAL_SAMPLES ?? '1');
const reportPath = process.env.ADMIN_EVAL_REPORT_PATH;

const enabled = Boolean(baseUrl && model && e2eCleanupSecret);

if (enabled && (!Number.isInteger(samples) || samples < 1)) {
  throw new Error(`ADMIN_EVAL_SAMPLES must be a positive integer, got: ${process.env.ADMIN_EVAL_SAMPLES}`);
}

// One session, one chat and the quest poll per turn.
const PER_TURN_MS = 2 * 60 * 1000;
const TIMEOUT_MS = ADMIN_EVAL_CASES.length * samples * PER_TURN_MS;

describe.skipIf(!enabled)('admin assistant eval (live deployment)', () => {
  let auth: LakeRagAuth | undefined;

  // Removes the admin and the target user, which share one testId.
  afterAll(async () => {
    await auth?.cleanup();
  }, MAX_429_WAIT_MS + 30_000);

  it(
    'answers the admin question set',
    async () => {
      auth = await resolveLakeRagAuth({ baseUrl: baseUrl!, e2eCleanupSecret, userOverrides: { isAdmin: true } });
      const target = await auth.mintUser({ initialCredits: TARGET_CREDITS });
      const api: LakeRagApi = { baseUrl: baseUrl!, authorization: auth.authorization };

      const turns = await runAdminEval(api, ADMIN_EVAL_CASES, { model: model!, samples, target: target.email });
      const report = buildAdminEvalReport(turns, { model: model!, samples });
      if (reportPath) writeAdminEvalReport(reportPath, report);
      // stdout directly: vitest can drop console output from a passing test.
      process.stdout.write(`\n${formatAdminEvalReport(report)}\n`);
    },
    TIMEOUT_MS
  );
});
