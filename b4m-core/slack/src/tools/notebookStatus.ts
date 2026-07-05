import { IUserDocument } from '@bike4mind/common';

/**
 * Show current notebook configuration for the user.
 *
 * Extracted from CommandHandler.handleSlashCommand /notebook status.
 */

export interface NotebookStatusParams {
  user: IUserDocument;
}

export interface NotebookStatusResult {
  success: boolean;
  message: string;
  defaultNotebookId?: string;
  autoCreate: boolean;
}

export function notebookStatus(params: NotebookStatusParams): NotebookStatusResult {
  const { user } = params;
  const slackSettings = user.slackSettings || {};

  return {
    success: true,
    message: `📓 Current notebook: ${slackSettings.defaultNotebookId || 'Auto-create mode'}\n🤖 Auto-create: ${slackSettings.autoCreateNotebook !== false ? 'Enabled' : 'Disabled'}`,
    defaultNotebookId: slackSettings.defaultNotebookId,
    autoCreate: slackSettings.autoCreateNotebook !== false,
  };
}
