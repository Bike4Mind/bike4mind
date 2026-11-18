import type { Brief } from '@bike4mind/common';
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
    happened: brief.happened.map(({ id, text }) => ({ id, text })),
    handled: brief.handled.map(({ id, text }) => ({ id, text })),
    decisions: brief.decisions.map(({ id, text, approval }) => ({
      id,
      text,
      ...(approval && {
        approval: {
          questId: approval.questId,
          sessionId: approval.sessionId,
          pendingActionTs: approval.pendingActionTs,
        },
      }),
    })),
  };
}
