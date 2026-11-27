/**
 * Legacy in-chat QuestMaster plans.
 *
 * The in-chat plan feature is gone, but chat messages written while it was live still carry its
 * fields: `questMasterPlanId` points at a plan row, and `questMasterReply` holds the JSON the plan
 * generator stored when it could not build a plan. Neither is answer text, so a message carrying
 * either one renders the legacy note instead of a reply, and nothing fetches the old plan.
 *
 * The legacy plan conversion writes each saved plan as a markdown file in the user's own files,
 * under the folder below.
 */

export const LEGACY_QUESTMASTER_ARCHIVE_FOLDER = 'Questmaster archive';

export const LEGACY_QUESTMASTER_NOTE =
  'This reply had a QuestMaster plan. QuestMaster plans are no longer shown in chat. ' +
  `Saved plans were copied as markdown files to the "${LEGACY_QUESTMASTER_ARCHIVE_FOLDER}" folder in your files.`;

interface LegacyQuestMasterFields {
  questMasterPlanId?: string | null;
  questMasterReply?: string | null;
}

/** True when the message was written by the retired in-chat QuestMaster plan feature. */
export const isLegacyQuestMasterMessage = (message: LegacyQuestMasterFields | null | undefined): boolean =>
  !!message && (!!message.questMasterPlanId || !!message.questMasterReply);
