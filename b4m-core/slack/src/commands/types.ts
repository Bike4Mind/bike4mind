/**
 * Shared types for B4M command handlers
 */

import { IUserDocument } from '@bike4mind/common';
import { KnownBlock } from '@slack/web-api';

/** Response structure for Slack commands */
export interface SlackCommandResponse {
  text: string;
  blocks?: KnownBlock[];
  response_type: 'ephemeral' | 'in_channel';
}

/** Result returned by B4M command handlers */
export interface B4mCommandResult {
  response?: SlackCommandResponse;
  openModal?: boolean;
}

/** Context passed to B4M command handlers */
export interface B4mCommandContext {
  dbUser: IUserDocument;
  slackUserId: string;
  channelId: string;
  triggerId: string;
  botToken: string;
  /** Decrypted user token for user-scoped APIs (e.g., reminders). Undefined if not authorized. */
  userToken?: string;
  /** OAuth scopes granted by the user. Used to check feature availability. */
  userScopes?: string[];
}
