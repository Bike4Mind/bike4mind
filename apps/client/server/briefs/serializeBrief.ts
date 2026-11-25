import {
  PENDING_ACTION_TTL_MS,
  type Brief,
  type BriefApprovalState,
  type BriefItem,
  type BriefQuestionState,
  type BriefSourceRef,
} from '@bike4mind/common';
import { questRepository, type IAssistantBrief } from '@bike4mind/database';

type ApprovalRef = { pendingActionTs: number };

export type PendingActionState = Awaited<ReturnType<typeof questRepository.findPendingActionStates>>[number];

export type QuestionState = Awaited<ReturnType<typeof questRepository.findQuestionStates>>[number];

export type SerializeBriefDeps = {
  findPendingActionStates: (questIds: string[]) => Promise<PendingActionState[]>;
  findQuestionStates: (questIds: string[]) => Promise<QuestionState[]>;
};

const defaultDeps: SerializeBriefDeps = {
  findPendingActionStates: questIds => questRepository.findPendingActionStates(questIds),
  findQuestionStates: questIds => questRepository.findQuestionStates(questIds),
};

/**
 * Live state of a cited approval from its quest's current pending action and last recorded resolution.
 * Expiry uses the same strict `>` bound as resolveMcpPendingAction, so an action exactly at the TTL is
 * still pending.
 */
export function approvalStateFor(
  ref: ApprovalRef,
  quest: PendingActionState | undefined,
  now: Date
): BriefApprovalState {
  if (!quest) return 'resolved';
  const lapsed = now.getTime() - ref.pendingActionTs > PENDING_ACTION_TTL_MS;
  if (quest.pendingActionTs === ref.pendingActionTs) return lapsed ? 'lapsed' : 'pending';
  const { resolution } = quest;
  if (resolution?.ts === ref.pendingActionTs) return resolution.outcome;
  if (quest.pendingActionTs !== undefined) return 'replaced';
  if (resolution && resolution.ts > ref.pendingActionTs) return 'replaced';
  return lapsed ? 'lapsed' : 'resolved';
}

/**
 * Live state of a cited question. A reply from the brief or a picked choice answers it; a later turn in
 * its session, or a deleted quest, means the conversation moved past it.
 */
export function questionStateFor(repliedAt: Date | undefined, quest: QuestionState | undefined): BriefQuestionState {
  if (repliedAt || quest?.selected) return 'answered';
  if (!quest?.isLatest) return 'superseded';
  return 'open';
}

/**
 * The wire shape of stored briefs (`BriefSchema`), with each approval's live state from one batched
 * quest lookup. Internal fields such as the failure reason stay server-side.
 */
export async function serializeBriefs(
  briefs: IAssistantBrief[],
  now: Date = new Date(),
  deps: SerializeBriefDeps = defaultDeps
): Promise<Brief[]> {
  const decisions = briefs.flatMap(brief => brief.decisions);
  const questIds = [...new Set(decisions.flatMap(d => (d.approval ? [d.approval.questId] : [])))];
  const questionIds = [...new Set(decisions.flatMap(d => (d.question ? [d.question.questId] : [])))];
  const [states, questionStates] = await Promise.all([
    questIds.length > 0 ? deps.findPendingActionStates(questIds) : [],
    questionIds.length > 0 ? deps.findQuestionStates(questionIds) : [],
  ]);
  const byQuest = new Map(states.map(state => [state.questId, state]));
  const questionByQuest = new Map(questionStates.map(state => [state.questId, state]));

  return briefs.map(brief => ({
    id: brief._id.toString(),
    status: brief.status,
    createdAt: brief.createdAt.toISOString(),
    composedAt: brief.composedAt ? brief.composedAt.toISOString() : null,
    periodStart: brief.periodStart.toISOString(),
    periodEnd: brief.periodEnd.toISOString(),
    headline: brief.headline,
    happened: brief.happened.map(serializeItem),
    handled: brief.handled.map(serializeItem),
    decisions: brief.decisions.map(decision => ({
      ...serializeItem(decision),
      ...(decision.approval && {
        approval: {
          questId: decision.approval.questId,
          sessionId: decision.approval.sessionId,
          pendingActionTs: decision.approval.pendingActionTs,
          state: approvalStateFor(decision.approval, byQuest.get(decision.approval.questId), now),
        },
      }),
      ...(decision.question && {
        question: {
          questId: decision.question.questId,
          sessionId: decision.question.sessionId,
          options: [...decision.question.options],
          state: questionStateFor(decision.repliedAt, questionByQuest.get(decision.question.questId)),
        },
      }),
      ...(decision.followUp && {
        followUp: {
          kind: decision.followUp.kind,
          state: decision.followUp.state,
          remindAt: decision.followUp.remindAt ? decision.followUp.remindAt.toISOString() : null,
        },
      }),
      ...(decision.draftReply && {
        draftReply: {
          to: decision.draftReply.to,
          subject: decision.draftReply.subject,
          body: decision.draftReply.body,
        },
      }),
    })),
  }));
}

export async function serializeBrief(brief: IAssistantBrief, now?: Date, deps?: SerializeBriefDeps): Promise<Brief> {
  const [serialized] = await serializeBriefs([brief], now, deps);
  return serialized;
}

function serializeItem({ id, text, source }: BriefItem): BriefItem {
  return { id, text, ...(source && { source: serializeSource(source) }) };
}

function serializeSource(source: BriefSourceRef): BriefSourceRef {
  switch (source.kind) {
    case 'email':
      return { kind: 'email', emailId: source.emailId };
    case 'delegation':
      return { kind: 'delegation', delegationId: source.delegationId };
    case 'obligation':
      return { kind: 'obligation', obligationId: source.obligationId };
  }
}
