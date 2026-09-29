import { ApiKeyScope, QaRunIngestRequestSchema, qaRunFromWire } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireQaIngestKey } from '@server/qa/requireQaIngestKey';
import { ingestRun } from '@server/qa/ingestRun';
import { defaultAlarmDeps, evaluateAlarm } from '@server/qa/evaluateAlarm';

// Bytes. 2000 tests x 4000-char errors, worst case. Keep in sync with config.api.bodyParser below.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/qa/runs. Internal CI ingest, deliberately outside the public contract set (and so
 * the OpenAPI spec). Caller: scripts/qa-report.mjs. `requiredScopes` admits the confined
 * qa:ingest key; requireQaIngestKey adds API-key-only and the owner tag. A bad body throws a
 * ZodError, which errorHandler serves as a 422 naming the field.
 */
const handler = baseApi({ maxBodySize: MAX_BODY_BYTES, requiredScopes: [ApiKeyScope.QA_INGEST] }).post(
  async (req, res) => {
    requireQaIngestKey(req);
    const input = qaRunFromWire(QaRunIngestRequestSchema.parse(req.body));
    const result = await ingestRun(input);
    req.logger?.info(
      `[QA] ingest ${input.product}/${input.suite}/${input.env}@${input.branch} run=${result.runId} status=${result.status} created=${result.created}`
    );
    // Every ingest may alarm: evaluateAlarm's persisted claim posts once per run, and a retry
    // after a failed or interrupted attempt still gets its turn.
    try {
      await evaluateAlarm(
        result.runId,
        defaultAlarmDeps(msg => req.logger?.info(msg))
      );
    } catch (err) {
      // The run is already stored; a Slack or lookup failure must not fail ingest.
      req.logger?.error(`[QA] alarm failed for run=${result.runId}: ${(err as Error)?.message}`);
    }
    return res.status(200).json({ run_id: result.runId, status: result.status, created: result.created });
  }
);

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '4mb' } },
};

export default handler;
