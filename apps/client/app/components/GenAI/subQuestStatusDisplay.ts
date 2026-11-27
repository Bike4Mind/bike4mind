import {
  normalizeSubQuestStatus,
  PLAN_STATUS_DISPLAY,
  SUB_QUEST_TO_PLAN_STATUS,
  type PlanStatusColor,
} from '@bike4mind/common';

export type SubQuestStatusColor = PlanStatusColor;

/**
 * Chip color for a sub-quest status as read from the database.
 *
 * Takes `string`, not `SubQuestStatus`, because the value comes off a persisted document and the
 * mongoose enum did not gate the update path for the collection's whole history - so a retired
 * token can still arrive here. Retired tokens are resolved through the shared normalizer rather
 * than a local alias list: the previous switch carried its own guesses (`done`, `started`,
 * `failed`, `error`), none of which was ever a SUB-QUEST status, while missing the one alias that
 * was real - hyphenated `in-progress` fell through to neutral instead of the warning colour its
 * underscore twin gets. Note `failed` is not invented in general: it is a live member of
 * NODE_STATUS_VALUES (b4m-core/common/src/types/entities/QuestNodeTypes.ts), a separate
 * vocabulary that never reaches a sub-quest.
 */
export const getSubQuestStatusColor = (status: string): SubQuestStatusColor => {
  const canonical = normalizeSubQuestStatus(status);
  const planStatus = canonical === null ? null : SUB_QUEST_TO_PLAN_STATUS[canonical];
  // `deleted` has no plan status; it stays neutral rather than taking the docx export's red.
  return planStatus === null ? 'neutral' : PLAN_STATUS_DISPLAY[planStatus].color;
};
