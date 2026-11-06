import { randomUUID } from 'crypto';
import type { Context } from 'aws-lambda';
import { Resource } from 'sst';
import { connectDB } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { sweepAbuseAssessments } from '@server/security/abuseAssessment/abuseAssessment';
import { linkedAccountGroupEvidence } from '@server/security/abuseAssessment/linkedAccountEvidence';
import { applyAutoContainment, liveAutoContainmentDeps } from '@server/security/autoContainment/executor';

/** Stop starting new assessments this long before the Lambda timeout. */
const STOP_MARGIN_MS = 60_000;

/**
 * Hourly assessments of unreviewed shadow detections (apps/client/server/security/abuseAssessment),
 * each judgment handed to automated containment (security/autoContainment, autoContainmentConfig).
 * A no-op unless abuseAssessmentEnabled, the sweep, a rollout percent and a model are all configured.
 */
export async function handler(_event: never, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    stage: Resource.App.stage,
  });
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const result = await sweepAbuseAssessments({
    logger,
    shouldStop: () => context.getRemainingTimeInMillis() < STOP_MARGIN_MS,
    deps: {
      groupEvidence: linkedAccountGroupEvidence,
      afterAssessment: item => applyAutoContainment(item, liveAutoContainmentDeps(logger)),
    },
  });
  logger.info('Abuse assessment sweep finished', result);
  return result;
}
