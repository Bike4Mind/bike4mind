import { buildConfirmationButtons } from '@bike4mind/slack';

type QuestWithPendingAction = {
  _id: { toString(): string };
  pendingAction?: { ts: number };
};

export function buildPendingActionButtons(quest: QuestWithPendingAction) {
  if (!quest.pendingAction) {
    throw new Error('Cannot build confirmation buttons without a pending action');
  }

  return buildConfirmationButtons(quest._id.toString(), quest.pendingAction.ts);
}
