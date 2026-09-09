import { normalizeSubQuestStatus, type SubQuestStatus } from '@bike4mind/common';

/** The Joy palette names a Chip accepts, narrowed to the ones this mapping uses. */
export type SubQuestStatusColor = 'success' | 'warning' | 'neutral' | 'danger';

/**
 * Chip palette per canonical status, exhaustive over SubQuestStatus so adding a status fails the
 * build here instead of silently rendering in the neutral fallback.
 *
 * `deleted` is intentionally `neutral` rather than `danger`: that is what the previous switch
 * produced for it (via its `default` arm), and the docx export's red for deleted is a separate
 * decision that belongs to whoever owns the visual language, not to a refactor. The two
 * deliberately disagree until someone decides.
 */
const STATUS_COLORS: Record<SubQuestStatus, SubQuestStatusColor> = {
  not_started: 'neutral',
  in_progress: 'warning',
  completed: 'success',
  skipped: 'neutral',
  deleted: 'neutral',
};

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
  return canonical === null ? 'neutral' : STATUS_COLORS[canonical];
};
