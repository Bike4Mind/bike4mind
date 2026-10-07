import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { Resource } from 'sst';
import { adminSettingsRepository, releaseNoteRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import {
  ChatModels,
  ReleaseNotesConfigSchema,
  type ReleaseNote,
  ReleaseNotesJobPayloadSchema,
  type ReleaseNotesConfig,
  type ReleaseNotesJobPayload,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  createReleaseNotesCompleter,
  triageReleaseNotes,
  writeReleaseNotes,
  type TokenUsage,
} from './releaseNotes/generate';
import { finalizeReleaseNote } from './releaseNotes/finalize';

const SETTING_NAME = 'releaseNotesConfig';
const MS_PER_HOUR = 60 * 60 * 1000;
const TOKENS_PER_MILLION = 1_000_000;
// Under the 5-minute Lambda timeout in infra/queues.ts, so a slow LLM still fails here and emits the Failure metric.
export const GENERATION_BUDGET_MS = 4 * 60 * 1000;
// Leaves the post inside the Lambda timeout after a full generation budget; a hang would retry and re-announce.
const SLACK_TIMEOUT_MS = 15_000;

// USD per 1M tokens. Unknown models price high on purpose so the EstimatedCost alarm notices them.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  [ChatModels.GPT4o_MINI]: { input: 0.15, output: 0.6 },
  [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: { input: 0.8, output: 4.0 },
};
const FALLBACK_PRICING = { input: 3.0, output: 15.0 };

const estimateCost = (modelId: string, usage: TokenUsage): number => {
  const price = MODEL_PRICING[modelId] ?? FALLBACK_PRICING;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / TOKENS_PER_MILLION;
};

/** Bodies from the retired What's New generation cron carry `generatedDate`; they are acked and dropped. */
const isLegacyPayload = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'generatedDate' in body;

async function loadConfig(logger: Logger): Promise<ReleaseNotesConfig | null> {
  const settings = await getSettingsByNames([SETTING_NAME], { adminSettings: adminSettingsRepository }, { logger });
  const raw: unknown = settings[SETTING_NAME];
  let value: unknown = raw ?? {};
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const parsed = ReleaseNotesConfigSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn(`[releaseNotes] ${SETTING_NAME} is malformed; treating as disabled`, { issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

const CATEGORY_LABEL: Record<ReleaseNote['items'][number]['category'], string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

// Slack mrkdwn control characters; escaping them keeps model output from forming <!channel> or links.
const escapeSlack = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildSlackText(note: ReleaseNote, releaseUrl: string): string {
  const hours = Math.max(0, Math.round((note.publishAt.getTime() - Date.now()) / MS_PER_HOUR));
  const status =
    note.status === 'hidden'
      ? 'No customer-facing changes; stored hidden and will not publish.'
      : `Goes live in ${hours}h (${note.publishAt.toISOString()}). Edit it before then to change or hide it.`;
  const lines = [`*Release notes for <${releaseUrl}|${escapeSlack(note.releaseTag)}>*`, status];
  if (note.headline) lines.push('', `*${escapeSlack(note.headline)}*`);
  if (note.summary) lines.push(escapeSlack(note.summary));
  for (const item of note.items) lines.push(`- [${CATEGORY_LABEL[item.category]}] ${escapeSlack(item.text)}`);
  return lines.join('\n');
}

/** Best effort: the note is already stored, so a Slack problem only warns and never fails the message. */
async function postToSlack(
  note: ReleaseNote,
  releaseUrl: string,
  config: ReleaseNotesConfig,
  logger: Logger
): Promise<void> {
  if (!config.slackTeamId || !config.slackChannelId) {
    logger.info('[releaseNotes] no Slack target configured; skipping announcement');
    return;
  }
  try {
    const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(config.slackTeamId);
    if (!workspace?.slackBotToken) {
      logger.warn('[releaseNotes] no Slack bot token for the configured workspace; skipping announcement');
      return;
    }
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${workspace.slackBotToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: config.slackChannelId,
        text: buildSlackText(note, releaseUrl),
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) logger.warn('[releaseNotes] Slack announcement rejected', { error: result.error });
  } catch (err) {
    logger.warn('[releaseNotes] Slack announcement failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Generates, finalizes and stores the note. A denylist hit in the headline or summary gets one editorial
 * rewrite; triage is not repeated.
 */
async function generateAndStore(
  payload: ReleaseNotesJobPayload,
  config: ReleaseNotesConfig,
  logger: Logger
): Promise<{ note: ReleaseNote; preserved: boolean; usage: TokenUsage; modelId: string }> {
  const deadline = Date.now() + GENERATION_BUDGET_MS;
  const { complete, modelId } = await createReleaseNotesCompleter(config, logger, deadline);
  const triage = await triageReleaseNotes(payload.prs, complete);
  const usage: TokenUsage = { ...triage.usage };

  let feedback: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const generated = await writeReleaseNotes(payload.prs, triage.notes, complete, feedback);
    usage.inputTokens += generated.usage.inputTokens;
    usage.outputTokens += generated.usage.outputTokens;

    const result = finalizeReleaseNote(generated.draft, payload, config, logger);
    if (result.kind === 'ok') {
      const { note, preserved } = await releaseNoteRepository.upsertGenerated(result.note);
      return { note: preserved ? note : result.note, preserved, usage, modelId };
    }
    feedback = result.reasons;
  }
  throw new Error(`[releaseNotes] headline or summary still hit the denylist after a rewrite: ${feedback.join('; ')}`);
}

async function processPayload(payload: ReleaseNotesJobPayload, logger: Logger): Promise<void> {
  logger.updateMetadata({ releaseTag: payload.releaseTag });

  const config = await loadConfig(logger);
  if (!config?.enabled) {
    logger.info(`[releaseNotes] ${SETTING_NAME} is disabled; skipping ${payload.releaseTag}`);
    return;
  }

  // Dimension keys match the retired What's New generator so its dashboards keep their series.
  const environment = Resource.App.stage;
  const startedAt = Date.now();
  let outcome: Awaited<ReturnType<typeof generateAndStore>>;
  try {
    outcome = await generateAndStore(payload, config, logger);
  } catch (err) {
    await emitModalGenerationMetrics([
      {
        name: 'Failure',
        value: 1,
        dimensions: {
          environment,
          releaseTag: payload.releaseTag,
          errorType: err instanceof Error ? err.name : 'UnknownError',
        },
        unit: StandardUnit.Count,
      },
    ]);
    throw err;
  }

  const { note, preserved, usage, modelId } = outcome;
  if (preserved) {
    logger.info('[releaseNotes] stored note was edited by a human; kept it and skipped the announcement');
  } else {
    await postToSlack(note, payload.releaseUrl, config, logger);
  }

  await emitModalGenerationMetrics([
    {
      name: 'Success',
      value: 1,
      dimensions: { environment, releaseTag: payload.releaseTag, repository: 'release-notes' },
      unit: StandardUnit.Count,
    },
    {
      name: 'Duration',
      value: Date.now() - startedAt,
      dimensions: { environment, releaseTag: payload.releaseTag },
      unit: StandardUnit.Milliseconds,
    },
    { name: 'InputTokens', value: usage.inputTokens, dimensions: { environment, modelId }, unit: StandardUnit.Count },
    { name: 'OutputTokens', value: usage.outputTokens, dimensions: { environment, modelId }, unit: StandardUnit.Count },
    {
      name: 'EstimatedCost',
      value: estimateCost(modelId, usage),
      dimensions: { environment, modelId },
      unit: StandardUnit.None,
    },
  ]);
}

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  for (const record of event.Records) {
    // Invalid JSON throws here on purpose: a corrupt body belongs in the DLQ, not silently acked.
    const body: unknown = JSON.parse(record.body);

    if (isLegacyPayload(body)) {
      logger.warn('[releaseNotes] dropping legacy whatsNewGeneration payload', { messageId: record.messageId });
      await emitModalGenerationMetrics([{ name: 'LegacyPayloadDropped', value: 1, unit: StandardUnit.Count }]);
      continue;
    }

    const parsed = ReleaseNotesJobPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`[releaseNotes] invalid job payload: ${parsed.error.message}`);
    }

    await processPayload(parsed.data, logger);
  }
});
