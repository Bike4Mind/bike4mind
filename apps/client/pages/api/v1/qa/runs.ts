import { ingestQaRunContract, qaRunFromWire } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireQaIngestKey } from '@server/qa/requireQaIngestKey';
import { ingestRun } from '@server/qa/ingestRun';
import { defaultAlarmDeps, evaluateAlarm } from '@server/qa/evaluateAlarm';

// Bytes. 2000 tests x 4000-char errors, worst case. Keep in sync with config.api.bodyParser below.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** POST /api/v1/qa/runs. Contract: b4m-core/common/src/api-contract/contracts/qa.contract.ts. Caller: scripts/qa-report.mjs. */
const handler = nextRouteForContract(ingestQaRunContract, { maxBodySize: MAX_BODY_BYTES }).post(async (req, res) => {
  requireQaIngestKey(req);
  const input = qaRunFromWire(req.validated);
  const result = await ingestRun(input);
  req.logger?.info(
    `[QA] ingest ${input.product}/${input.suite}/${input.env}@${input.branch} run=${result.runId} status=${result.status} created=${result.created}`
  );
  // Only a first ingest can alarm, so a retried or re-sent run never re-posts.
  if (result.created) {
    try {
      await evaluateAlarm(
        result.runId,
        defaultAlarmDeps(msg => req.logger?.info(msg))
      );
    } catch (err) {
      // The run is already stored; a Slack or lookup failure must not fail ingest.
      req.logger?.error(`[QA] alarm failed for run=${result.runId}: ${(err as Error)?.message}`);
    }
  }
  return res.status(200).json({ run_id: result.runId, status: result.status, created: result.created });
});

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '4mb' } },
};

export default handler;
