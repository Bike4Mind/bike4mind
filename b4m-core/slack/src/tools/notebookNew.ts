import { Logger } from '@bike4mind/observability';
import { IUserDocument } from '@bike4mind/common';
import { getSlackDb, getSlackDeps } from '../di/registry';
import { updateUserSlackSettings } from '../handlers/notebook-manager';

/**
 * Create a new notebook and set it as the user's default.
 *
 * Extracted from CommandHandler.handleSlashCommand /notebook new.
 */

export interface NotebookNewParams {
  user: IUserDocument;
  slackUserId: string;
  logger: Logger;
}

export interface NotebookNewResult {
  success: boolean;
  message: string;
  notebookId?: string;
  notebookName?: string;
}

export async function notebookNew(params: NotebookNewParams): Promise<NotebookNewResult> {
  const { user, slackUserId, logger } = params;
  const notebookName = `Slack Chat - ${new Date().toLocaleDateString()}`;

  const { defineAbilitiesFor } = getSlackDb();
  const { sessionManager } = getSlackDeps();
  const ability = defineAbilitiesFor(user);

  const { session: newSession } = await sessionManager.getOrCreateSession({
    user,
    sessionName: notebookName,
    ability,
    logger,
  });

  const slackSettings = user.slackSettings || {};
  await updateUserSlackSettings(user.id, {
    ...slackSettings,
    slackUserId,
    defaultNotebookId: newSession.id,
  });

  return {
    success: true,
    message: `✅ Created new notebook: ${newSession.name} (ID: ${newSession.id})`,
    notebookId: newSession.id,
    notebookName: newSession.name,
  };
}
