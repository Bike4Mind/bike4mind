import type { Brief, BriefItem, BriefSourceRef } from '@bike4mind/common';
import type { IAssistantBrief } from '@bike4mind/database';

/** The wire shape of a stored brief (`BriefSchema`). Internal fields such as the failure reason stay server-side. */
export function serializeBrief(brief: IAssistantBrief): Brief {
  return {
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
  };
}

function serializeItem({ id, text, source }: BriefItem): BriefItem {
  return { id, text, ...(source && { source: serializeSource(source) }) };
}

function serializeSource(source: BriefSourceRef): BriefSourceRef {
  return source.kind === 'email'
    ? { kind: 'email', emailId: source.emailId }
    : { kind: 'delegation', delegationId: source.delegationId };
}
