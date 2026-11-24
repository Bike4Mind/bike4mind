/**
 * Worker for the org feedback LLM summary: aggregate -> LLM pass -> S3 artifact -> websocket.
 *
 * Runs on the quest-export queue rather than one of its own. A queue here is 1:1 with a lambda in
 * the infra stack, and that lambda already carries everything this needs (Bedrock invoke, the app
 * files bucket, the websocket API, a 10-minute timeout), so the message carries a `jobType` and
 * `questExport.dispatch` routes on it - the same multiplex `sreJob.ts` uses.
 *
 * INHERITED, and deliberately so: the quest-export DLQ, its retry count and its visibility/lambda
 * timeouts. A failure here lands in the quest-export DLQ and pages the quest-export runbook, and a
 * redrive replays the message through the export handler's dispatch. Anyone changing either side's
 * timeout or retry policy is changing both.
 */

import { randomUUID } from 'node:crypto';
import {
  ChatModels,
  type ModelInfo,
  ORG_FEEDBACK_SUMMARY_JOB_TYPE,
  ORG_FEEDBACK_SUMMARY_TAG_LIMIT,
  OrgFeedbackSummaryArtifact,
} from '@bike4mind/common';
import {
  OrgFeedbackSummaryJob,
  adminSettingsRepository,
  apiKeyRepository,
  orgFeedbackReport,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { createBoundedZeroCreditOperationalUsageStore } from '@bike4mind/database/zero-credit-operational-usage';
import { S3Storage } from '@bike4mind/fab-pipeline';
import {
  buildApiKeyTable,
  getAvailableModels,
  getLlmByModel,
  isLlmTimeoutError,
  SafetyRefusalError,
  type CompletionInfo,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService, recordOperationalUsage } from '@bike4mind/services';
import {
  latchUsage,
  priceCompletionUsage,
  timedOutCompletionUsageFields,
  type CompletionUsage,
} from '@bike4mind/services/billing/completionMeter';
import { getSettingsByNames } from '@bike4mind/utils';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';
import { z } from 'zod';

const DEFAULT_SUMMARY_MODEL = ChatModels.CLAUDE_4_5_HAIKU_BEDROCK;
const SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_TIMEOUT_MS = 60_000;
const MIN_SUMMARY_BUDGET_MS = 120_000;
const USAGE_LOOKUP_TIMEOUT_MS = 10_000;
const USAGE_WRITE_TIMEOUT_MS = 20_000;

export type CheckRunBudget = (minimumRemainingMs?: number) => void;
type SummaryUsage = CompletionUsage & Pick<CompletionInfo, 'cacheWrite1hInputTokens' | 'stopReason'>;
type SummaryOwner = Pick<OrgFeedbackSummaryMessage, 'organizationId' | 'userId'>;

export const OrgFeedbackSummaryPayload = z.object({
  jobType: z.literal(ORG_FEEDBACK_SUMMARY_JOB_TYPE),
  summaryJobId: z.string(),
  organizationId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  userId: z.string(),
});

export type OrgFeedbackSummaryMessage = z.infer<typeof OrgFeedbackSummaryPayload>;

/** Where an org's summaries live in the app files bucket. */
export const summaryS3Key = (organizationId: string, summaryJobId: string) =>
  `org-feedback-summaries/${organizationId}/${summaryJobId}.json`;

async function sendProgress(
  userId: string,
  summaryJobId: string,
  organizationId: string,
  status: 'processing' | 'completed' | 'failed',
  progress: number,
  errorMessage?: string
) {
  await sendToClient(userId, Resource.websocket.managementEndpoint, {
    action: 'org_feedback_summary_progress',
    summaryJobId,
    organizationId,
    status,
    progress,
    ...(errorMessage ? { errorMessage } : {}),
  });
}

const bucketList = (rows: { key: string; count: number }[], limit = rows.length) =>
  rows
    .slice(0, limit)
    .map(row => `- ${row.key}: ${row.count}`)
    .join('\n') || '- none';

/**
 * Renders the aggregate as the prompt's only input.
 *
 * Counts are NOT suppressed at low cell sizes. The same viewer is already reading exact counts,
 * including per-member ones, on the Analysis tab this summary sits in, so rounding here would only
 * make the prose disagree with the panel beside it without withholding anything. What the redaction
 * actually turns on is the fields chosen: no feedback text, no member names, no ids.
 */
function buildPrompt(report: Awaited<ReturnType<typeof orgFeedbackReport>>) {
  // Either cut hides tags: the report's own top-N ceiling, or this prompt's shorter one.
  const tagsPartial = report.byTagTruncated === true || report.byTag.length > ORG_FEEDBACK_SUMMARY_TAG_LIMIT;
  const tagNote = tagsPartial
    ? `\n(only the top ${Math.min(report.byTag.length, ORG_FEEDBACK_SUMMARY_TAG_LIMIT)} tags by count are listed; more tags exist, so do not describe this as the complete tag breakdown)`
    : '';
  return `Feedback window: ${report.range.from} to ${report.range.to}
Total items: ${report.totals.count}

By type:
${bucketList(report.byType)}

By status:
${bucketList(report.byStatus)}

By area of the product:
${bucketList(report.bySubject)}

By tag (items with no tag are absent, so these do not sum to the total):${tagNote}
${bucketList(report.byTag, ORG_FEEDBACK_SUMMARY_TAG_LIMIT)}

By day:
${bucketList(report.byDay.map(row => ({ key: row.day, count: row.count })))}`;
}

async function recordSummaryUsage({
  requestId,
  owner,
  usage,
  modelInfo,
  latencyMs,
  failed,
  timedOut,
  logger,
}: {
  requestId: string;
  owner?: SummaryOwner;
  usage: SummaryUsage;
  modelInfo: ModelInfo;
  latencyMs: number;
  failed: boolean;
  timedOut: boolean;
  logger: Logger;
}): Promise<void> {
  const priced = priceCompletionUsage(modelInfo, usage);
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens } = priced;
  if (inputTokens + outputTokens + cachedInputTokens + cacheWriteTokens <= 0) {
    logger.warn('Organization feedback summary provider did not report token usage', { model: modelInfo.id });
    return;
  }
  if (!owner) {
    logger.warn('Organization feedback summary usage owner does not match the job');
    return;
  }

  const store = createBoundedZeroCreditOperationalUsageStore({
    lookupTimeoutMS: USAGE_LOOKUP_TIMEOUT_MS,
    writeTimeoutMS: USAGE_WRITE_TIMEOUT_MS,
  });
  const [userResult, organizationResult] = await Promise.allSettled([
    store.findUserById(owner.userId),
    store.findOrganizationById(owner.organizationId),
  ]);
  if (userResult.status === 'rejected' || organizationResult.status === 'rejected') {
    logger.warn('Could not look up organization feedback summary usage owner');
    return;
  }
  const user = userResult.value;
  const organization = organizationResult.value;
  if (!user || !organization) {
    logger.warn('Organization feedback summary usage owner is missing');
    return;
  }
  if (failed) logger.warn('Recording reported usage after organization feedback summary provider failure');

  await recordOperationalUsage(
    {
      requestId,
      user,
      organization,
      feature: 'operations',
      source: 'system',
      bypassCreditBilling: true,
      provider: modelInfo.backend,
      model: modelInfo.id,
      ...priced,
      operation: 'org_feedback_summary',
      finishReason: usage.stopReason,
      latencyMs,
    },
    {
      db: {
        adminSettings: adminSettingsRepository,
        usageEvents: {
          record: async event => {
            try {
              const fields = timedOut ? timedOutCompletionUsageFields(priced) : undefined;
              return await store.usageEvents.record({ ...event, ...fields });
            } catch {
              throw new Error('Organization feedback summary usage insert failed');
            }
          },
        },
      },
      logger,
    }
  );
}

async function generateSummary(
  message: OrgFeedbackSummaryMessage,
  owner: SummaryOwner | undefined,
  promptBody: string,
  model: string,
  checkBudget: CheckRunBudget,
  logger: Logger
) {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
  const apiKeyTable = buildApiKeyTable(coreKeys);

  const models = await getAvailableModels(apiKeyTable);
  const modelInfo = models.find(m => m.id === model);
  // Unlike the quest export, where the summary is a bonus on top of a zip, the summary IS the
  // product here - an unavailable model is a failed job, not a quieter success.
  if (!modelInfo) throw new Error(`Summary model ${model} is not available`);

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: message.userId });
  if (!llm) throw new Error(`Failed to initialize LLM for ${model}`);

  const systemPrompt = `You are summarizing user feedback for the administrators of an organization.

You will be given COUNTS ONLY - no feedback text. Do not invent quotes, examples or individual
reports, and do not attribute anything to a named person.

Write 200-400 words covering:
- the overall volume for the window and how it moved across it
- which types and areas of the product dominate, with the numbers
- what the status mix says about how much is still open
- one or two things worth looking into, phrased as questions the counts raise rather than
  conclusions the counts cannot support`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: promptBody },
  ];

  checkBudget(MIN_SUMMARY_BUDGET_MS);
  const requestId = randomUUID();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeoutError = new Error(`Summary generation timeout after ${SUMMARY_TIMEOUT_MS}ms`);
  const deadline = setTimeout(() => controller.abort(timeoutError), SUMMARY_TIMEOUT_MS);
  const usage: SummaryUsage = {};
  let responseText = '';
  let failed = false;
  let timedOut = false;
  try {
    await llm.complete(
      model,
      messages,
      {
        temperature: 0.3,
        maxTokens: SUMMARY_MAX_TOKENS,
        stream: false,
        retryMode: 'abort-aware',
        abortSignal: controller.signal,
      },
      async (texts, info) => {
        latchUsage(usage, info);
        if (info?.cacheWrite1hInputTokens !== undefined) usage.cacheWrite1hInputTokens = info.cacheWrite1hInputTokens;
        if (info?.stopReason !== undefined) usage.stopReason = info.stopReason;
        if (!controller.signal.aborted && texts?.length) responseText += texts.filter(Boolean).join('');
      }
    );
    controller.signal.throwIfAborted();
  } catch (error) {
    failed = true;
    const adapterTimeout = isLlmTimeoutError(error);
    timedOut = controller.signal.aborted || adapterTimeout;
    if ((adapterTimeout || error instanceof SafetyRefusalError) && error.usage) {
      const { turnUsage, ...counts } = error.usage;
      latchUsage(usage, { ...counts, turnUsage: turnUsage?.slice() });
    }
    if (error instanceof SafetyRefusalError) usage.stopReason = 'refusal';
    throw controller.signal.aborted ? timeoutError : error;
  } finally {
    clearTimeout(deadline);
    await recordSummaryUsage({
      requestId,
      owner,
      usage,
      modelInfo,
      latencyMs: Math.round(performance.now() - startedAt),
      failed,
      timedOut,
      logger,
    }).catch(() => logger.warn('Could not record organization feedback summary usage', { model: modelInfo.id }));
  }

  if (!responseText.trim()) throw new Error('Empty summary response from LLM');
  return responseText.trim();
}

export async function runOrgFeedbackSummary(
  message: OrgFeedbackSummaryMessage,
  logger: Logger,
  checkBudget: CheckRunBudget = () => undefined
): Promise<void> {
  const { summaryJobId, organizationId, userId } = message;
  logger.updateMetadata({ handler: 'orgFeedbackSummary', summaryJobId, organizationId, userId });

  const job = await OrgFeedbackSummaryJob.findOne({ summaryJobId });
  // The row is TTL'd, and a redelivery can outlive it. Nothing to report against, so swallow.
  if (!job) {
    logger.warn(`No summary job record for ${summaryJobId}; dropping message`);
    return;
  }
  if (job.status === 'completed') {
    logger.info(`Summary job ${summaryJobId} already completed; re-emitting completion`);
    await sendProgress(userId, summaryJobId, organizationId, 'completed', 100);
    return;
  }

  try {
    checkBudget();
    // A redelivery re-running a failed job works against a window that job already released, so
    // the status moves without re-taking `activeKey`: a newer job may hold the window by now.
    await OrgFeedbackSummaryJob.updateOne({ summaryJobId }, { status: 'processing' });
    await sendProgress(userId, summaryJobId, organizationId, 'processing', 10);

    const members = await organizationRepository.findMemberUserIds(organizationId);
    const report = await orgFeedbackReport({
      organizationId,
      from: new Date(message.startDate),
      to: new Date(message.endDate),
      members,
    });

    await sendProgress(userId, summaryJobId, organizationId, 'processing', 40);
    checkBudget();
    const model = (await adminSettingsRepository.getSettingsValue('OrgFeedbackSummaryModel')) || DEFAULT_SUMMARY_MODEL;
    const owner =
      job.requestedBy === userId && job.organizationId === organizationId
        ? { userId: job.requestedBy, organizationId: job.organizationId }
        : undefined;
    const summary = await generateSummary(message, owner, buildPrompt(report), model, checkBudget, logger);

    const artifact: OrgFeedbackSummaryArtifact = {
      summaryJobId,
      organizationId,
      range: report.range,
      generatedAt: new Date().toISOString(),
      model,
      summary,
      counts: {
        totals: report.totals,
        byDay: report.byDay,
        bySubject: report.bySubject,
        byType: report.byType,
        byStatus: report.byStatus,
        byTag: report.byTag,
        byTagTruncated: report.byTagTruncated,
      },
    };

    checkBudget();
    const key = summaryS3Key(organizationId, summaryJobId);
    // Bucket name resolved from SST at runtime, never written down.
    await new S3Storage(Resource.appFilesBucket.name).upload(JSON.stringify(artifact), key, {
      ContentType: 'application/json',
    });

    // `activeKey` moves to the job's own id at every terminal state, which is what releases this
    // (org, window) for a later re-run - see the model's note.
    await OrgFeedbackSummaryJob.updateOne(
      { summaryJobId },
      { status: 'completed', s3Key: key, activeKey: summaryJobId }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Org feedback summary ${summaryJobId} failed: ${errorMessage}`);

    // Each side-effect below is isolated: a rejection here must never replace `error`, or SQS
    // retries and the DLQ see this secondary failure instead of the root cause. Both are attempted
    // even if one throws, since a failed updateOne must not skip the progress frame the client is
    // waiting on.
    try {
      await OrgFeedbackSummaryJob.updateOne(
        { summaryJobId },
        { status: 'failed', errorMessage, activeKey: summaryJobId }
      );
    } catch (updateError) {
      logger.error(`Failed to mark summary job ${summaryJobId} as failed: ${String(updateError)}`);
    }

    // Tell the waiting client before rethrowing: the rethrow hands the message back to SQS, and
    // the retries plus the DLQ that follow are silent from the browser's side.
    try {
      await sendProgress(userId, summaryJobId, organizationId, 'failed', 100, errorMessage);
    } catch (progressError) {
      logger.error(`Failed to send failure progress for summary job ${summaryJobId}: ${String(progressError)}`);
    }

    throw error;
  }

  // Outside the failure boundary: the job is durably completed by this point, so a disconnected
  // socket here must not rewrite it as failed or trigger an SQS retry of already-completed work.
  try {
    await sendProgress(userId, summaryJobId, organizationId, 'completed', 100);
  } catch (progressError) {
    logger.error(`Failed to send completion progress for summary job ${summaryJobId}: ${String(progressError)}`);
  }
}
