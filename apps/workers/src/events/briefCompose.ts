import { withEventContext } from '@workers/utils/eventContext';
import { loadPendingBriefEmails } from './loadPendingBriefEmails';
import { loadPendingBriefDelegations } from './loadPendingBriefDelegations';
import { loadDueBriefObligations, toBriefObligation } from './loadDueBriefObligations';
import { notifyHeldBlockRuns } from '@bike4mind/server-utils/briefs/notifyHeldBlockRuns';
import { BriefEvents } from '@bike4mind/server-utils/utils/eventBus';
import {
  agentExecutionRepository,
  assistantBriefRepository,
  delegatedItemRepository,
  emailTriageItemRepository,
  questRepository,
  userRepository,
  assistantInstructionRepository,
  type IAssistantBrief,
} from '@bike4mind/database';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { publishPushNotification, briefDeepLink } from '@bike4mind/server-utils/utils/pushNotifications';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { BRIEF_LIMITS, PENDING_ACTION_TTL_MS, type PushNotificationEvent } from '@bike4mind/common';
import { recordSessionOperationalUsage } from '@workers/events/recordSessionOperationalUsage';
import { payerCanFundSessionOperation } from '@workers/events/sessionOperationalCreditGate';
import {
  assembleBrief,
  blockBriefPushCategories,
  briefedDelegationIds,
  briefedEmailIds,
  briefPushBody,
  briefPushContent,
  buildBriefPrompt,
  emptyBrief,
  hasActivity,
  hasModelActivity,
  reminderBrief,
  type BriefActivity,
  type ComposedBrief,
} from './briefCompose.composition';
import { assembleFollowUpBrief, buildFollowUpPrompt } from './briefCompose.followUp';

/**
 * `brief.compose` consumer: composes one user's brief (POST /api/v1/briefs creates the `composing`
 * row and publishes the event, as does the schedule reconciler), stores it and pushes `brief_ready`.
 *
 * Composition is one pass of the platform's operations model over the user's recent agent runs, the
 * approvals and questions still waiting on them, counts of their triaged email and delegated items and
 * of their confirmed bills coming due; there is no tool loop. Failures settle the row as `failed` so a
 * polling client stops waiting, and are never rethrown: a retry cannot fix a refused balance or a
 * malformed reply, and the user can simply compose again.
 */

const MAX_RUNS = 30;
const MAX_APPROVALS = 12;
const MAX_QUESTIONS = 12;
const MODEL_MAX_TOKENS = 1500;
// A follow-up reply carries a whole email draft (up to BRIEF_LIMITS.draftBody chars) besides the items.
const FOLLOW_UP_MAX_TOKENS = 3000;
const APPROVAL_SUMMARY_LIMIT = 600;

type LogLike = Pick<Logger, 'info' | 'warn' | 'error'>;

export type BriefComposeDeps = {
  now: () => Date;
  users: Pick<typeof userRepository, 'findById'>;
  briefs: Pick<
    typeof assistantBriefRepository,
    'findById' | 'markReady' | 'markFailed' | 'discardComposing' | 'removeEmailSourcedItems' | 'markRemindersSurfaced'
  >;
  loadActivity(brief: IAssistantBrief, now: Date): Promise<BriefActivity>;
  /** Whether the call may run: 'ok', or why not (AI access held, or the balance cannot cover it). */
  canCompose(userId: string): Promise<'ok' | 'ai_access_held' | 'insufficient_credits'>;
  /** Sends the prompt to the model and returns its raw reply. */
  complete(userId: string, briefId: string, prompt: string, maxTokens?: number): Promise<string>;
  /** The user's standing instruction texts. A failing load means the brief is composed without them. */
  loadInstructions(userId: string): Promise<string[]>;
  push(event: PushNotificationEvent): Promise<void>;
  /** Summary push for runs a busy block held, sent when that block's brief is discarded or fails. */
  notifyHeldRuns(userId: string, block: { start: Date; end: Date }): Promise<void>;
  /** `markBriefed` records the triage items a ready brief carried; the rest stay pending for the next brief. */
  emails: Pick<typeof emailTriageItemRepository, 'markBriefed' | 'storedEmailIds'>;
  /** Records the settled delegated items a ready brief carried; pending ones stay for a later brief. */
  delegations: Pick<typeof delegatedItemRepository, 'markBriefed'>;
  logger: LogLike;
};

export async function loadStandingInstructionTexts(userId: string): Promise<string[]> {
  return (await assistantInstructionRepository.listByUser(userId)).map(instruction => instruction.text);
}

async function loadInstructionsSafely(deps: BriefComposeDeps, userId: string): Promise<string[]> {
  try {
    return await deps.loadInstructions(userId);
  } catch (error) {
    deps.logger.warn('[Brief] could not load standing instructions; composing without them', { userId, error });
    return [];
  }
}

export async function composeBrief(
  deps: BriefComposeDeps,
  input: { briefId: string; userId: string; scheduled?: boolean }
): Promise<void> {
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

  if (brief.origin === 'followUp') {
    await composeFollowUp(deps, brief, user.preferences?.briefSchedule?.timeZone);
    return;
  }

  try {
    const now = deps.now();
    const activity = await deps.loadActivity(brief, now);

    let composed: ComposedBrief;
    let periodEnd: Date | undefined;
    const gate = hasModelActivity(activity) ? await deps.canCompose(input.userId) : 'ok';
    if (gate !== 'ok' && input.scheduled && activity.reminders.length > 0) {
      // Due reminders need no model call, so they still surface; the unbriefed activity stays in the next
      // brief's window because this one is stored as covering none of it.
      logger.info('[Brief] scheduled brief limited to reminders; composition not allowed', {
        briefId: input.briefId,
        gate,
      });
      composed = reminderBrief(activity);
      periodEnd = brief.periodStart;
    } else if (gate !== 'ok') {
      // A scheduled start the user cannot pay for is dropped like an empty one, so a held account or an
      // empty balance does not leave a failed row in the brief list every scheduled day.
      if (input.scheduled) {
        logger.info('[Brief] scheduled brief skipped; composition not allowed', { briefId: input.briefId, gate });
        await briefs.discardComposing(input.briefId);
      } else {
        await briefs.markFailed(input.briefId, gate);
      }
      await notifyIfBlockBrief(deps, brief);
      return;
    } else if (hasModelActivity(activity)) {
      const instructions = await loadInstructionsSafely(deps, input.userId);
      try {
        const reply = await deps.complete(input.userId, input.briefId, buildBriefPrompt(activity, instructions));
        composed = assembleBrief(reply, activity);
      } catch (error) {
        // Same fallback as the gate branch: the reconciler never re-arms a failed scheduled brief.
        if (!input.scheduled || activity.reminders.length === 0) throw error;
        logger.warn('[Brief] scheduled brief limited to reminders; composition failed', {
          briefId: input.briefId,
          error,
        });
        composed = reminderBrief(activity);
        periodEnd = brief.periodStart;
      }
    } else if (hasActivity(activity)) {
      composed = reminderBrief(activity);
    } else if (input.scheduled) {
      // A scheduled brief with nothing to report is dropped: no row, no push.
      await briefs.discardComposing(input.briefId);
      await notifyIfBlockBrief(deps, brief);
      return;
    } else {
      composed = emptyBrief();
    }

    const composedAt = deps.now();
    const settled = await briefs.markReady(input.briefId, composed, composedAt, { periodEnd });
    if (!settled) return;

    await settleBriefedEmails(deps, input.userId, briefedEmailIds(composed), composedAt);
    await settleBriefedDelegations(deps, input.userId, briefedDelegationIds(composed, activity), composedAt);
    await settleSurfacedReminders(deps, input.userId, activity, composedAt);
    if (periodEnd) await notifyIfBlockBrief(deps, brief);

    const { body, briefAction } = briefPushContent(composed, activity);
    await deps.push({
      userId: input.userId,
      category: 'brief_ready',
      title: 'Your brief is ready',
      body,
      deepLink: briefDeepLink(input.briefId),
      collapseId: `brief_ready:${input.briefId}`,
      briefId: input.briefId,
      ...(briefAction && { briefAction }),
      ...(brief.trigger === 'busy_block' && { blockEndCategories: blockBriefPushCategories(composed, activity) }),
    });
  } catch (error) {
    logger.error('[Brief] composition failed', { briefId: input.briefId, error });
    await briefs.markFailed(input.briefId, 'composition_failed');
    await notifyIfBlockBrief(deps, brief);
  }
}

async function notifyIfBlockBrief(deps: BriefComposeDeps, brief: IAssistantBrief) {
  if (brief.trigger === 'busy_block' && brief.busyBlock) await deps.notifyHeldRuns(brief.userId, brief.busyBlock);
}

/**
 * A brief from a dictated memo: no activity load and no empty-window discard, since the user is waiting on it.
 * Every decision is stored pending; nothing is sent or scheduled here.
 */
async function composeFollowUp(deps: BriefComposeDeps, brief: IAssistantBrief, scheduleTimeZone: string | undefined) {
  const { briefs, logger } = deps;
  const briefId = brief._id.toString();
  try {
    const input = brief.followUpInput;
    if (!input?.transcript) {
      await briefs.markFailed(briefId, 'composition_failed');
      return;
    }
    const gate = await deps.canCompose(brief.userId);
    if (gate !== 'ok') {
      await briefs.markFailed(briefId, gate);
      return;
    }
    const now = deps.now();
    const timeZone = input.timeZone ?? scheduleTimeZone ?? 'UTC';
    const reply = await deps.complete(
      brief.userId,
      briefId,
      buildFollowUpPrompt(input.transcript, now, timeZone),
      FOLLOW_UP_MAX_TOKENS
    );
    const composed = assembleFollowUpBrief(reply, now);
    if (!(await briefs.markReady(briefId, composed, deps.now()))) return;
    await deps.push({
      userId: brief.userId,
      category: 'brief_ready',
      title: 'Your follow-ups are ready',
      body: briefPushBody(composed),
      deepLink: briefDeepLink(briefId),
      collapseId: `brief_ready:${briefId}`,
      briefId,
    });
  } catch (error) {
    // A JSON.parse SyntaxError message quotes the memo-derived reply, so only its name is logged.
    logger.error('[Brief] follow-up composition failed', {
      briefId,
      ...(error instanceof SyntaxError ? { errorName: error.name } : { error }),
    });
    await briefs.markFailed(briefId, 'composition_failed');
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

/** Never throws, like settleBriefedEmails: an unmarked item is carried into the next brief again rather than lost. */
async function settleBriefedDelegations(deps: BriefComposeDeps, userId: string, ids: string[], at: Date) {
  if (ids.length === 0) return;
  try {
    await deps.delegations.markBriefed(userId, ids, at);
  } catch (error) {
    deps.logger.error('[Brief] could not mark the briefed delegations', { userId, error });
  }
}

/** Never throws, like settleBriefedEmails: an unmarked reminder is listed again in the next brief rather than lost. */
async function settleSurfacedReminders(deps: BriefComposeDeps, userId: string, activity: BriefActivity, at: Date) {
  if (activity.reminders.length === 0) return;
  try {
    await deps.briefs.markRemindersSurfaced(userId, activity.reminders, at);
  } catch (error) {
    deps.logger.warn('[Brief] marking reminders surfaced failed; they will be listed again', { userId, error });
  }
}

export async function loadActivity(brief: IAssistantBrief, now: Date): Promise<BriefActivity> {
  const block = brief.trigger === 'busy_block' ? brief.busyBlock : null;
  const { items } = await agentExecutionRepository.findByUserIdPaginated(
    brief.userId,
    { fromDate: brief.periodStart, ...(block && { toDate: brief.periodEnd }) },
    { limit: MAX_RUNS }
  );
  const sessionIds = [...new Set(items.map(item => item.sessionId))];
  const pending = await questRepository.findPendingActionsBySessionIds(
    sessionIds,
    now.getTime() - PENDING_ACTION_TTL_MS,
    MAX_APPROVALS
  );
  const questions = await questRepository.findOpenQuestionsBySessionIds(
    sessionIds,
    block?.start ?? brief.periodStart,
    MAX_QUESTIONS
  );
  // Pending rather than windowed: an item a failed brief or a section cap left out is carried to the next brief.
  // A block brief takes only the block's arrivals; earlier pending items wait for the next regular brief.
  const emails = await loadPendingBriefEmails(brief.userId, brief.periodEnd, block?.start);
  const delegations = await loadPendingBriefDelegations(brief.userId, brief.periodEnd, now, block?.start);
  // Capped at the section size so every loaded reminder fits ahead of the other happened items.
  const reminders = await assistantBriefRepository.findDueReminders(brief.userId, now, BRIEF_LIMITS.itemsPerSection);
  const obligations = await loadDueBriefObligations(brief.userId, now);

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
    questions,
    emails: emails.map(item => ({
      emailId: item.emailId,
      kind: item.kind,
      summary: item.summary,
      ...(item.draftReply && {
        draftReply: { to: item.draftReply.to, subject: item.draftReply.subject, body: item.draftReply.body },
      }),
    })),
    delegations: delegations.map(item => ({
      delegationId: item._id.toString(),
      intent: item.intent,
      status: item.status,
      result: item.result,
    })),
    reminders: reminders.map(({ briefId, decisionId, text }) => ({ briefId, decisionId, text })),
    obligations: obligations.map(item => toBriefObligation(item, now)),
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
      loadInstructions: loadStandingInstructionTexts,
      canCompose: async userId => {
        const user = await userRepository.findById(userId);
        if (!user || aiAccessDeniedMessage(user)) return 'ai_access_held';
        const funded = await payerCanFundSessionOperation({ payerId: userId, operation: 'assistant brief', logger });
        return funded ? 'ok' : 'insufficient_credits';
      },
      complete: async (userId, briefId, prompt, maxTokens = MODEL_MAX_TOKENS) => {
        const startTime = Date.now();
        const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel({ endUserId: userId });
        let reply = '';
        let completionInfo: CompletionInfo | undefined;
        await llm.complete(
          modelId,
          [{ role: 'user', content: prompt }],
          { maxTokens },
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
      notifyHeldRuns: (userId, block) => notifyHeldBlockRuns(userId, block),
      emails: emailTriageItemRepository,
      delegations: delegatedItemRepository,
      logger,
    },
    input
  );
});
