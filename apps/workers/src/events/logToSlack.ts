import { Config } from '@server/utils/config';
import { CloudWatchLogsEvent, Context } from 'aws-lambda';
import { notifyEventLogsToSlack } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { sendToQueue } from '@server/utils/sqs';
import { adminSettingsRepository } from '@bike4mind/database';
import { connectDB } from '@bike4mind/database';
import { extractErrorType, normalizeErrorMessage } from '@server/services/liveopsFingerprint';
import { classifyError } from './logToSlackClassify';
import {
  SreClassification,
  SreSourceType,
  SreEventPayload,
  SreAgentConfig,
  getConfiguredRepoSlugs,
  resolveFullConfig,
  type ResolvedRepoConfig,
  type SreJobType,
} from '@bike4mind/common';
import * as util from 'node:util';
import * as zlib from 'node:zlib';
import { createHash } from 'crypto';

/**
 * Generate a SHA-1 fingerprint from error type + normalized message.
 */
function generateSreFingerprint(errorMessage: string): string {
  const errorType = extractErrorType(errorMessage);
  const normalized = normalizeErrorMessage(errorMessage);
  const source = `sre::${errorType}::${normalized}`;
  return createHash('sha1').update(source).digest('hex');
}

export const ingest = async (event: CloudWatchLogsEvent, _context: Context) => {
  // Existing Slack notification, always runs first.
  // All errors (including ThrottlingException) route to SLACK_ERROR_REPORTING_WEBHOOK_URL.
  // The previous dedicated-throttling-channel diversion (a temporary hardcoded webhook)
  // was removed once its webhook was revoked.
  await notifyEventLogsToSlack({
    event,
    stage: Config.STAGE,
    slackUrl: Config.SLACK_ERROR_REPORTING_WEBHOOK_URL,
  });

  // ── SRE Sentinel: CloudWatch error intake ──────────────────────────
  const logger = new Logger({ metadata: { handler: 'logToSlack', subsystem: 'sre-sentinel' } });
  try {
    // Decode the CloudWatch event (base64 + gunzip)
    const payload = Buffer.from(event.awslogs.data, 'base64');
    const decompressed = await util.promisify(zlib.gunzip)(payload);
    const logData = JSON.parse(decompressed.toString('utf8'));

    // Connect to DB (idempotent - uses cached connection)
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));

    // Check SRE agent config
    const sreConfig = (await adminSettingsRepository.getSettingsValue('sreAgentConfig')) as SreAgentConfig | undefined;
    if (!sreConfig) {
      return;
    }
    // Check if any configured repo has CloudWatch source enabled
    const configuredRepos = getConfiguredRepoSlugs(sreConfig);
    let targetRepoSlug = '';
    let repoConfig: ResolvedRepoConfig | null = null;
    for (const slug of configuredRepos) {
      const rc = resolveFullConfig(sreConfig, slug);
      if (rc?.enabled && rc.sources.cloudwatch.enabled) {
        targetRepoSlug = slug;
        repoConfig = rc;
        break;
      }
    }
    if (!repoConfig) return; // No repo with CloudWatch enabled

    const logGroup: string = logData.logGroup || '';

    for (const logEvent of logData.logEvents || []) {
      // Extract the JSON message from tab-separated fields
      // Format: timestamp\trequestId\tlogLevel\tjsonPayload\n
      const parts: string[] = logEvent.message.split('\t');
      const rawMessage = parts[3] || logEvent.message;

      // Try to parse structured JSON for richer metadata
      let errorMessage = rawMessage;
      let functionName: string | undefined;
      try {
        const parsed = JSON.parse(rawMessage);
        errorMessage = parsed.message || parsed.errorMessage || rawMessage;
        functionName = parsed.functionName;
      } catch {
        // Not JSON - use raw message as-is
      }

      // Classify via heuristics
      const classification = classifyError(rawMessage);
      if (classification === SreClassification.SKIP) {
        continue;
      }

      // Generate fingerprint
      const fingerprint = generateSreFingerprint(errorMessage);

      const srePayload: SreEventPayload = {
        source: SreSourceType.CLOUDWATCH,
        fingerprint,
        repoSlug: targetRepoSlug,
        classification,
        errorMessage,
        stackTrace: rawMessage,
        functionName,
        logGroup,
      };

      if (repoConfig.dryRun) {
        logger.info('Dispatching to sreJobQueue with dryRun flag', { payload: srePayload });
        srePayload.dryRun = true;
      }

      await sendToQueue(Resource.sreJobQueue.url, {
        ...srePayload,
        jobType: 'analysis' satisfies SreJobType,
      } as unknown as Record<string, unknown>);
      logger.info('Dispatched CloudWatch error to sreJobQueue', {
        fingerprint,
        classification,
        logGroup,
      });
    }
  } catch (error) {
    // SRE errors must never break existing Slack notification flow
    logger.error('Error processing CloudWatch event for SRE pipeline', { error });
  }
};
