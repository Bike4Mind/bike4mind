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
  briefedEmailIds,
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
  briefs: Pick<typeof assistantBriefRepository, 'findById' | 'markReady' | 'markFailed' | 'removeEmailSourcedItems'>;
  loadActivity(brief: IAssistantBrief, now: Date): Promise<BriefActivity>;
  /** Whether the call may run: 'ok', or why not (AI access held, or the balance cannot cover it). */
  canCompose(userId: string): Promise<'ok' | 'ai_access_held' | 'insufficient_credits'>;
  /** Sends the activity prompt to the model and returns its raw reply. */
  complete(userId: string, briefId: string, prompt: string): Promise<string>;
  push(event: PushNotificationEvent): Promise<void>;
  /** `markBriefed` records the triage items a ready brief carried; the rest stay pending for the next brief. */
  emails: Pick<typeof emailTriageItemRepository, 'markBriefed' | 'storedEmailIds'>;
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

    const composedAt = deps.now();
    const settled = await briefs.markReady(input.briefId, composed, composedAt);
    if (!settled) return;

    await settleBriefedEmails(deps, input.userId, briefedEmailIds(composed), composedAt);

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

/**
 * Runs after the brief is stored, and never throws so the push still goes out: an unmarked item is carried into
 * the next brief again rather than lost. The two steps are independent, so a failed mark still cleans up. An email deleted while this brief composed has lost its triage item by
 * now or will be pulled by its delete route, which removes triage items before brief items
 * (apps/client/pages/api/users/[id]/ingested-emails.ts).
 */
async function settleBriefedEmails(deps: BriefComposeDeps, userId: string, emailIds: string[], at: Date) {
  if (emailIds.length === 0) return;
  try {
    await deps.emails.markBriefed(userId, emailIds, at);
  } catch (error) {
    deps.logger.error('[Brief] could not mark the briefed emails', { userId, error });
  }
  try {
    const stored = new Set(await deps.emails.storedEmailIds(userId, emailIds));
    const deleted = emailIds.filter(id => !stored.has(id));
    if (deleted.length > 0) await deps.briefs.removeEmailSourcedItems(userId, deleted);
  } catch (error) {
    deps.logger.error('[Brief] could not drop brief items of deleted emails', { userId, error });
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
  // Pending rather than windowed: an item a failed brief or a section cap left out is carried to the next brief.
  const emails = await emailTriageItemRepository.listPending(brief.userId, brief.periodEnd, MAX_EMAIL_ITEMS);

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
      emails: emailTriageItemRepository,
      logger,
    },
    input
  );
});
