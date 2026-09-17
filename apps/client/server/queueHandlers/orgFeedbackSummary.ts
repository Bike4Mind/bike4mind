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

import { ChatModels, ORG_FEEDBACK_SUMMARY_JOB_TYPE, OrgFeedbackSummaryArtifact } from '@bike4mind/common';
import {
  OrgFeedbackSummaryJob,
  adminSettingsRepository,
  apiKeyRepository,
  orgFeedbackReport,
} from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';
import { z } from 'zod';

const SUMMARY_MODEL = ChatModels.CLAUDE_4_5_HAIKU_BEDROCK;
const SUMMARY_MAX_TOKENS = 2000;
const SUMMARY_TIMEOUT_MS = 60000;
/** How many tag rows reach the prompt; the long tail is noise in prose. */
const PROMPT_TAG_LIMIT = 20;

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
  return `Feedback window: ${report.range.from} to ${report.range.to}
Total items: ${report.totals.count}

By type:
${bucketList(report.byType)}

By status:
${bucketList(report.byStatus)}

By area of the product:
${bucketList(report.bySubject)}

By tag (items with no tag are absent, so these do not sum to the total):
${bucketList(report.byTag, PROMPT_TAG_LIMIT)}

By day:
${bucketList(report.byDay.map(row => ({ key: row.day, count: row.count })))}`;
}

async function generateSummary(message: OrgFeedbackSummaryMessage, promptBody: string, logger: Logger) {
  const dbAdapters = {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  };
  const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);
  const apiKeyTable = {
    openai: coreKeys.openai || undefined,
    anthropic: coreKeys.anthropic || undefined,
    gemini: coreKeys.gemini || undefined,
    bfl: coreKeys.bfl || undefined,
    ollama: coreKeys.ollama || undefined,
    xai: coreKeys.xai || undefined,
  };

  const models = await getAvailableModels(apiKeyTable);
  const modelInfo = models.find(m => m.id === SUMMARY_MODEL);
  // Unlike the quest export, where the summary is a bonus on top of a zip, the summary IS the
  // product here - an unavailable model is a failed job, not a quieter success.
  if (!modelInfo) throw new Error(`Summary model ${SUMMARY_MODEL} is not available`);

  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger, endUserId: message.userId });
  if (!llm) throw new Error(`Failed to initialize LLM for ${SUMMARY_MODEL}`);

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

  let responseText = '';
  await Promise.race([
    llm.complete(
      SUMMARY_MODEL,
      messages,
      { temperature: 0.3, maxTokens: SUMMARY_MAX_TOKENS, stream: false },
      async (texts: (string | null | undefined)[]) => {
        if (texts && texts.length > 0) responseText += texts.filter(Boolean).join('');
      }
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Summary generation timeout after ${SUMMARY_TIMEOUT_MS}ms`)),
        SUMMARY_TIMEOUT_MS
      )
    ),
  ]);

  if (!responseText.trim()) throw new Error('Empty summary response from LLM');
  return responseText.trim();
}

export async function runOrgFeedbackSummary(message: OrgFeedbackSummaryMessage, logger: Logger): Promise<void> {
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
    const summary = await generateSummary(message, buildPrompt(report), logger);

    const artifact: OrgFeedbackSummaryArtifact = {
      summaryJobId,
      organizationId,
      range: report.range,
      generatedAt: new Date().toISOString(),
      model: SUMMARY_MODEL,
      summary,
      counts: {
        totals: report.totals,
        byDay: report.byDay,
        bySubject: report.bySubject,
        byType: report.byType,
        byStatus: report.byStatus,
        byTag: report.byTag,
      },
    };

    const key = summaryS3Key(organizationId, summaryJobId);
    // Bucket name resolved from SST at runtime, never written down.
    await new S3Storage(Resource.appFilesBucket.name).upload(JSON.stringify(artifact), key, {
      ContentType: 'application/json',
    });

    // `activeKey` moves to the job's own id at every terminal state, which is what releases this
    // (org, window) for a later re-run - see the model's note. Nothing else may write it.
    await OrgFeedbackSummaryJob.updateOne(
      { summaryJobId },
      { status: 'completed', s3Key: key, activeKey: summaryJobId }
    );
    await sendProgress(userId, summaryJobId, organizationId, 'completed', 100);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Org feedback summary ${summaryJobId} failed: ${errorMessage}`);
    await OrgFeedbackSummaryJob.updateOne(
      { summaryJobId },
      { status: 'failed', errorMessage, activeKey: summaryJobId }
    );
    // Tell the waiting client before rethrowing: the rethrow hands the message back to SQS, and
    // the retries plus the DLQ that follow are silent from the browser's side.
    await sendProgress(userId, summaryJobId, organizationId, 'failed', 100, errorMessage);
    throw error;
  }
}
