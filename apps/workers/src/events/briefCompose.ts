import { withEventContext } from '@workers/utils/eventContext';
import { BriefEvents } from '@bike4mind/server-utils/utils/eventBus';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  emailTriageItemRepository,
  questRepository,
  userRepository,
  type IAssistantBrief,
} from '@bike4mind/database';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { publishPushNotification, briefDeepLink } from '@bike4mind/server-utils/utils/pushNotifications';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { PushNotificationEvent } from '@bike4mind/common';
import { recordSessionOperationalUsage } from '@workers/events/recordSessionOperationalUsage';
import { payerCanFundSessionOperation } from '@workers/events/sessionOperationalCreditGate';
import {
  assembleBrief,
  briefPushBody,
  buildBriefPrompt,
  emptyBrief,
  hasActivity,
  type BriefActivity,
  type ComposedBrief,
} from './briefCompose.composition';

/**
 * `brief.compose` consumer: composes one user's brief (POST /api/v1/briefs creates the `composing`
 * row and publishes the event), stores it and pushes `brief_ready`.
 *
 * Composition is one pass of the platform's operations model over the user's recent agent runs, the
 * approvals still waiting on them and counts of their triaged email; there is no tool loop. Failures settle the row as `failed` so a
 * polling client stops waiting, and are never rethrown: a retry cannot fix a refused balance or a
 * malformed reply, and the user can simply compose again.
 */

const APPROVAL_TTL_MS = 15 * 60 * 1000; // Mirrors the pending-action lifecycle (pendingActions.contract.ts).
const MAX_RUNS = 30;
const MAX_APPROVALS = 12;
const MAX_EMAIL_ITEMS = 24;
const MODEL_MAX_TOKENS = 1500;
const APPROVAL_SUMMARY_LIMIT = 600;

type LogLike = Pick<Logger, 'info' | 'warn' | 'error'>;

export type BriefComposeDeps = {
  now: () => Date;
  users: { findById(id: string): Promise<{ id: string } | null> };
  briefs: Pick<typeof assistantBriefRepository, 'findById' | 'markReady' | 'markFailed'>;
  loadActivity(brief: IAssistantBrief, now: Date): Promise<BriefActivity>;
  /** Whether the call may run: 'ok', or why not (AI access held, or the balance cannot cover it). */
  canCompose(userId: string): Promise<'ok' | 'ai_access_held' | 'insufficient_credits'>;
  /** Sends the activity prompt to the model and returns its raw reply. */
  complete(userId: string, briefId: string, prompt: string): Promise<string>;
  push(event: PushNotificationEvent): Promise<void>;
  logger: LogLike;
};

export async function composeBrief(deps: BriefComposeDeps, input: { briefId: string; userId: string }): Promise<void> {
  const { briefs, logger } = deps;
  const brief = await briefs.findById(input.briefId);
  if (!brief || brief.userId !== input.userId) {
    logger.warn('[Brief] brief missing or not owned by the event user; skipping', { briefId: input.briefId });
    return;
  }
  if (brief.status !== 'composing') {
    logger.info('[Brief] brief already settled; skipping redelivery', { briefId: input.briefId });
    return;
  }

  const user = await deps.users.findById(input.userId);
  if (!user) {
    await briefs.markFailed(input.briefId, 'user_missing');
    return;
  }

  try {
    const now = deps.now();
    const activity = await deps.loadActivity(brief, now);

    let composed: ComposedBrief;
    if (hasActivity(activity)) {
      const gate = await deps.canCompose(input.userId);
      if (gate !== 'ok') {
        await briefs.markFailed(input.briefId, gate);
        return;
      }
      const reply = await deps.complete(input.userId, input.briefId, buildBriefPrompt(activity));
      composed = assembleBrief(reply, activity);
    } else {
      composed = emptyBrief();
    }

    const settled = await briefs.markReady(input.briefId, composed, deps.now());
    if (!settled) return;

    await deps.push({
      userId: input.userId,
      category: 'brief_ready',
      title: 'Your brief is ready',
      body: briefPushBody(composed),
      deepLink: briefDeepLink(input.briefId),
      collapseId: `brief_ready:${input.briefId}`,
      briefId: input.briefId,
    });
  } catch (error) {
    logger.error('[Brief] composition failed', { briefId: input.briefId, error });
    await briefs.markFailed(input.briefId, 'composition_failed');
  }
}

async function loadActivity(brief: IAssistantBrief, now: Date): Promise<BriefActivity> {
  const { items } = await agentExecutionRepository.findByUserIdPaginated(
    brief.userId,
    { fromDate: brief.periodStart },
    { limit: MAX_RUNS }
  );
  const sessionIds = [...new Set(items.map(item => item.sessionId))];
  const pending = await questRepository.findPendingActionsBySessionIds(
    sessionIds,
    now.getTime() - APPROVAL_TTL_MS,
    MAX_APPROVALS
  );
  // Triage items are selected by creation time inside the brief's window rather than marked consumed: a
  // failed brief leaves them for the next one, whose window starts where the last ready brief ended
  // (apps/client/server/briefs/composeBrief.ts, bounded by its maximum lookback).
  const emails = await emailTriageItemRepository.listForWindow(
    brief.userId,
    brief.periodStart,
    brief.periodEnd,
    MAX_EMAIL_ITEMS
  );

  return {
    periodStart: brief.periodStart,
    periodEnd: brief.periodEnd,
    runs: items.map(item => ({
      id: item.id,
      query: item.query,
      status: item.status,
      finishedAt: item.completedAt,
      errorMessage: item.errorMessage,
    })),
    approvals: pending.map(action => ({
      questId: action.questId,
      sessionId: action.sessionId,
      pendingActionTs: action.ts,
      tool: action.tool,
      summary: JSON.stringify(action.params ?? {}).slice(0, APPROVAL_SUMMARY_LIMIT),
    })),
    emails: emails.map(item => ({
      emailId: item.emailId,
      kind: item.kind,
      summary: item.summary,
      ...(item.draftReply && {
        draftReply: { to: item.draftReply.to, subject: item.draftReply.subject, body: item.draftReply.body },
      }),
    })),
  };
}

export const handler = withEventContext(async (event, logger) => {
  const input = BriefEvents.Compose.schema.parse(event.properties);
  logger.updateMetadata({ briefId: input.briefId, userId: input.userId });

  await composeBrief(
    {
      now: () => new Date(),
      users: userRepository,
      briefs: assistantBriefRepository,
      loadActivity,
      canCompose: async userId => {
        const user = await userRepository.findById(userId);
        if (!user || aiAccessDeniedMessage(user)) return 'ai_access_held';
        const funded = await payerCanFundSessionOperation({ payerId: userId, operation: 'assistant brief', logger });
        return funded ? 'ok' : 'insufficient_credits';
      },
      complete: async (userId, briefId, prompt) => {
        const startTime = Date.now();
        const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel({ endUserId: userId });
        let reply = '';
        let completionInfo: CompletionInfo | undefined;
        await llm.complete(
          modelId,
          [{ role: 'user', content: prompt }],
          { maxTokens: MODEL_MAX_TOKENS },
          async (chunks: (string | null | undefined)[], info?: CompletionInfo) => {
            reply += chunks.filter(Boolean).join('');
            if (info) completionInfo = info;
          }
        );
        // The brief id stands in for the session id: a brief belongs to no notebook, and the id keys the receipt.
        await recordSessionOperationalUsage({
          userId,
          sessionId: briefId,
          operation: 'assistant_brief',
          modelId,
          modelInfo,
          completionInfo,
          startTime,
          logger,
        });
        return reply;
      },
      push: pushEvent => publishPushNotification(pushEvent, logger),
      logger,
    },
    input
  );
});
