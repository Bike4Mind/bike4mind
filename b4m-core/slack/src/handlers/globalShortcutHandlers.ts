/**
 * Global Shortcut Handlers
 *
 * Handles global shortcuts from Slack's shortcuts menu (accessed via `/` command).
 * These shortcuts are accessible from anywhere in Slack without typing commands.
 */

import { WebClient } from '@slack/web-api';
import { Logger } from '@bike4mind/observability';
import { IUserDocument, requireEnv } from '@bike4mind/common';
import { getSlackDeps, getSlackDb } from '../di/registry';

/** Payload structure for global shortcut events */
export interface GlobalShortcutPayload {
  type: 'shortcut';
  callback_id: string;
  trigger_id: string;
  user: {
    id: string;
    name: string;
    team_id?: string;
  };
  team: {
    id: string;
    domain: string;
  };
}

/** Shortcut callback IDs */
export const SHORTCUT_CALLBACK_IDS = {
  CREATE_NOTEBOOK: 'create_notebook_shortcut',
  VIEW_NOTEBOOKS: 'view_notebooks_shortcut',
  QUICK_ASK: 'quick_ask_shortcut',
  HELP: 'help_shortcut',
} as const;

const logger = new Logger({ metadata: { component: 'GlobalShortcutHandlers' } });

/**
 * Escapes special characters for Slack mrkdwn format.
 * Prevents user input from being interpreted as formatting or special links.
 * @see https://api.slack.com/reference/surfaces/formatting#escaping
 */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Main handler for global shortcuts (/ menu)
 * Routes to specific handler based on callback_id
 */
export async function handleGlobalShortcut(
  payload: GlobalShortcutPayload,
  botToken?: string,
  prefetchedUser?: IUserDocument | null,
  appName?: string,
  workspaceId?: string
): Promise<object> {
  const { callback_id, trigger_id, user } = payload;

  logger.info('[Slack Shortcut] Processing global shortcut', {
    callbackId: callback_id,
    slackUserId: user.id,
    hasTriggerId: !!trigger_id,
    hasBotToken: !!botToken,
  });

  if (!botToken) {
    logger.error('[Slack Shortcut] Missing bot token');
    return {};
  }

  if (!trigger_id) {
    logger.error('[Slack Shortcut] Missing trigger_id');
    return {};
  }

  // Look up user if not prefetched
  const dbUser = prefetchedUser ?? (await findUserBySlackId(user.id));

  switch (callback_id) {
    case SHORTCUT_CALLBACK_IDS.CREATE_NOTEBOOK:
      return await handleCreateNotebookShortcut(trigger_id, botToken, dbUser, appName);

    case SHORTCUT_CALLBACK_IDS.VIEW_NOTEBOOKS:
      return await handleViewNotebooksShortcut(trigger_id, botToken, dbUser, appName);

    case SHORTCUT_CALLBACK_IDS.QUICK_ASK:
      return await handleQuickAskShortcut(trigger_id, botToken, dbUser, appName, workspaceId);

    case SHORTCUT_CALLBACK_IDS.HELP:
      return await handleHelpShortcut(trigger_id, botToken, appName);

    default:
      logger.warn('[Slack Shortcut] Unknown shortcut callback_id', { callbackId: callback_id });
      return {};
  }
}

/**
 * Find user by Slack ID
 */
async function findUserBySlackId(slackUserId: string): Promise<IUserDocument | null> {
  const { User } = getSlackDb();
  const user = await (User as any).findOne({
    'slackSettings.slackUserId': slackUserId,
  });
  return user;
}

/**
 * Open a modal for unlinked users with setup instructions
 */
async function openUnlinkedUserModal(
  triggerId: string,
  botToken: string,
  appName?: string
): Promise<{ success: boolean; error?: string }> {
  const client = new WebClient(botToken);

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'Account Not Linked',
        },
        close: {
          type: 'plain_text',
          text: 'Close',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':x: *Your Slack account is not linked to ' + (appName || 'B4M') + '.*',
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '*To link your account:*\n\n' +
                '1. Log in to the web app\n' +
                '2. Go to *Profile Settings*\n' +
                '3. Navigate to *Slack Integration*\n' +
                '4. Enter your Slack Member ID and save\n\n' +
                '_To find your Member ID: Click your profile picture in Slack → "Profile" → "More" → "Copy member ID"_',
            },
          },
        ],
      },
    });
    return { success: true };
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to open unlinked user modal', { error });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Handle "Create Notebook" shortcut
 * Opens a modal to create a new notebook
 */
async function handleCreateNotebookShortcut(
  triggerId: string,
  botToken: string,
  dbUser: IUserDocument | null,
  appName?: string
): Promise<object> {
  // Check if user is linked
  if (!dbUser) {
    await openUnlinkedUserModal(triggerId, botToken, appName);
    return {};
  }

  const client = new WebClient(botToken);

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'create_notebook_modal',
        title: {
          type: 'plain_text',
          text: 'Create Notebook',
        },
        submit: {
          type: 'plain_text',
          text: 'Create',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'notebook_name_block',
            element: {
              type: 'plain_text_input',
              action_id: 'notebook_name_input',
              placeholder: {
                type: 'plain_text',
                text: 'Enter notebook name...',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Notebook Name',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: ":bulb: _Leave blank to auto-generate a name based on today's date_",
              },
            ],
          },
        ],
        private_metadata: JSON.stringify({ userId: dbUser.id }),
      },
    });

    logger.info('[Slack Shortcut] Opened create notebook modal', { userId: dbUser.id });
    return {};
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to open create notebook modal', { error });
    return {};
  }
}

/**
 * Handle "View My Notebooks" shortcut
 * Opens a modal displaying recent notebooks
 */
async function handleViewNotebooksShortcut(
  triggerId: string,
  botToken: string,
  dbUser: IUserDocument | null,
  appName?: string
): Promise<object> {
  // Check if user is linked
  if (!dbUser) {
    await openUnlinkedUserModal(triggerId, botToken, appName);
    return {};
  }

  const client = new WebClient(botToken);

  const { Session } = getSlackDb();

  try {
    // Fetch recent notebooks for this user
    const notebooks = await (Session as any)
      .find({
        userId: dbUser.id,
        deletedAt: { $exists: false },
      })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select('name createdAt updatedAt')
      .lean();

    const notebookBlocks: any[] = [];

    if (notebooks.length === 0) {
      notebookBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':notebook: *No notebooks found.*\n\nUse the "Create Notebook" shortcut or `/notebook create` to create one!',
        },
      });
    } else {
      notebookBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:notebook: *Your Recent Notebooks* (${notebooks.length})`,
        },
      });
      notebookBlocks.push({ type: 'divider' });

      for (const notebook of notebooks) {
        const updatedAt = new Date(notebook.updatedAt);
        const timeAgo = getRelativeTimeString(updatedAt);

        notebookBlocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${notebook.name || 'Untitled Notebook'}*\n_Updated ${timeAgo}_`,
          },
        });
      }
    }

    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: 'My Notebooks',
        },
        close: {
          type: 'plain_text',
          text: 'Close',
        },
        blocks: notebookBlocks,
      },
    });

    logger.info('[Slack Shortcut] Opened view notebooks modal', {
      userId: dbUser.id,
      notebookCount: notebooks.length,
    });
    return {};
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to open view notebooks modal', { error });
    return {};
  }
}

/**
 * Handle "Quick Ask B4M" shortcut
 * Opens a modal for asking a quick question
 */
async function handleQuickAskShortcut(
  triggerId: string,
  botToken: string,
  dbUser: IUserDocument | null,
  appName?: string,
  workspaceId?: string
): Promise<object> {
  // Check if user is linked
  if (!dbUser) {
    await openUnlinkedUserModal(triggerId, botToken, appName);
    return {};
  }

  const client = new WebClient(botToken);

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'quick_ask_modal',
        title: {
          type: 'plain_text',
          text: 'Quick Ask',
        },
        submit: {
          type: 'plain_text',
          text: 'Ask',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'question_block',
            element: {
              type: 'plain_text_input',
              action_id: 'question_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'What would you like to ask?',
              },
            },
            label: {
              type: 'plain_text',
              text: 'Your Question',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: ':bulb: _Your question will be answered in a DM with the assistant._',
              },
            ],
          },
        ],
        private_metadata: JSON.stringify({ userId: dbUser.id, workspaceId }),
      },
    });

    logger.info('[Slack Shortcut] Opened quick ask modal', { userId: dbUser.id, workspaceId });
    return {};
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to open quick ask modal', { error });
    return {};
  }
}

/**
 * Handle "Help" shortcut
 * Opens a modal with help information
 */
async function handleHelpShortcut(triggerId: string, botToken: string, appName?: string): Promise<object> {
  const client = new WebClient(botToken);

  try {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: {
          type: 'plain_text',
          text: appName ? `${appName} Help` : 'B4M Help',
        },
        close: {
          type: 'plain_text',
          text: 'Close',
        },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*Available AI Agents*' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '• *@agent* - General-purpose assistant\n' +
                '• *@pm* - Project management (Jira, Confluence)\n' +
                '• *@dev* - Development tasks (GitHub, code)\n' +
                '• *@analyst* - Business and data analysis\n' +
                '• *@researcher* - Information gathering',
            },
          },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '*Example Commands*' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '• `@dev create issue for [description]`\n' +
                '• `@pm create Jira epic from this thread`\n' +
                '• `@agent summarize this thread`\n' +
                '• `@agent list files` or `share latest file`',
            },
          },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '*Slash Commands*' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '*Schedule Messages*\n' +
                '• `/b4m schedule` - Open scheduler dialog\n' +
                '• `/b4m schedule "msg" in 5 minutes` - Inline\n' +
                '• `/b4m schedule list` - View scheduled\n' +
                '• `/b4m schedule cancel <id>` - Cancel',
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '*Notebooks*\n' +
                '• `/notebook list` - List your notebooks\n' +
                '• `/notebook create [name]` - Create new\n' +
                '• `/notebook set <id>` - Set default\n' +
                '• `/notebook status` - Show settings',
            },
          },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '*Shortcuts (`/` menu)*' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '• *Create Notebook* - Create a new notebook\n' +
                '• *View My Notebooks* - See your recent notebooks\n' +
                '• *Quick Ask* - Ask a quick question\n' +
                '• *Help* - Show this help',
            },
          },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '*Tips*' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '• Add priority: P0, P1, P2, P3\n' +
                '• Assign to people by name\n' +
                '• Say "with images" for screenshots\n' +
                '• Use timeframes: "last hour", "yesterday"',
            },
          },
        ],
      },
    });

    logger.info('[Slack Shortcut] Opened help modal');
    return {};
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to open help modal', { error });
    return {};
  }
}

/**
 * Get relative time string (e.g., "2 hours ago", "Yesterday")
 */
function getRelativeTimeString(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// Modal Submission Handlers
// ============================================================================

/** Payload structure for modal view submissions */
export interface ViewSubmissionPayload {
  type: 'view_submission';
  user: {
    id: string;
    name?: string;
  };
  view: {
    callback_id: string;
    private_metadata?: string;
    state: {
      values: Record<string, Record<string, { value?: string }>>;
    };
  };
}

/** Response structure for view submission handlers */
export interface ViewSubmissionResponse {
  response_action?: 'errors';
  errors?: Record<string, string>;
}

/**
 * Handle Create Notebook modal submission
 * Creates a new notebook for the user and DMs them the link
 */
export async function handleCreateNotebookSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string
): Promise<ViewSubmissionResponse> {
  const { view, user: slackUser } = payload;

  // Parse private_metadata to get userId
  let userId: string | undefined;
  try {
    const metadata = JSON.parse(view.private_metadata || '{}');
    userId = metadata.userId;
  } catch {
    logger.error('[Slack Shortcut] Failed to parse private_metadata');
  }

  if (!userId) {
    return {
      response_action: 'errors',
      errors: {
        notebook_name_block: 'Unable to identify user. Please try again.',
      },
    };
  }

  // Get notebook name from form
  const notebookName = view.state.values?.notebook_name_block?.notebook_name_input?.value?.trim() || '';

  // Generate default name if empty
  const finalName = notebookName || `Slack Chat ${new Date().toLocaleDateString()}`;

  try {
    // Get user document to create ability
    const { User, defineAbilitiesFor: defineAbilitiesForCreate } = getSlackDb();
    const { sessionManager } = getSlackDeps();
    const dbUser = await (User as any).findById(userId);
    if (!dbUser) {
      return {
        response_action: 'errors',
        errors: {
          notebook_name_block: 'User not found. Please try again.',
        },
      };
    }

    // SECURITY: Verify the userId from private_metadata matches the authenticated Slack user
    // This prevents attackers from modifying private_metadata to act as another user
    if (dbUser.slackSettings?.slackUserId !== slackUser.id) {
      logger.warn('[Slack Shortcut] User mismatch in create notebook submission', {
        claimedUserId: userId,
        authenticatedSlackUserId: slackUser.id,
        dbUserSlackId: dbUser.slackSettings?.slackUserId,
      });
      return {
        response_action: 'errors',
        errors: {
          notebook_name_block: 'Unauthorized access.',
        },
      };
    }

    // Create ability for the user
    const ability = defineAbilitiesForCreate(dbUser);

    // Create the notebook
    const session = await (sessionManager as any).createSession(userId, { name: finalName }, ability, {
      setLastNotebook: true,
    });

    logger.info('[Slack Shortcut] Created notebook from shortcut', {
      userId,
      sessionId: session.id,
      name: finalName,
    });

    // DM the user with the notebook link (async, don't wait)
    if (botToken && slackUser?.id) {
      sendNotebookCreatedDM(slackUser.id, session.id, finalName, botToken).catch(error => {
        logger.error('[Slack Shortcut] Failed to send notebook DM', { error, userId });
      });
    }

    // Modal closes automatically on success (empty response)
    return {};
  } catch (error) {
    logger.error('[Slack Shortcut] Failed to create notebook', { error, userId });
    return {
      response_action: 'errors',
      errors: {
        notebook_name_block: 'Failed to create notebook. Please try again.',
      },
    };
  }
}

/**
 * Send a DM to the user with the newly created notebook link
 */
async function sendNotebookCreatedDM(
  slackUserId: string,
  sessionId: string,
  notebookName: string,
  botToken: string
): Promise<void> {
  const client = new WebClient(botToken);

  try {
    // Open DM channel
    const dmResult = await client.conversations.open({
      users: slackUserId,
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      logger.error('[Slack Shortcut] Failed to open DM for notebook link', { slackUserId });
      return;
    }

    // App URL is set per-deployment; no brand fallback.
    const appUrl = requireEnv('APP_URL', process.env.APP_URL);
    const notebookUrl = `${appUrl}/notebooks/${sessionId}`;

    // Drop the brand clause when APP_NAME is unset.
    const brand = process.env.APP_NAME || '';
    const openLinkLabel = brand ? `Open in ${brand}` : 'Open Notebook';

    // Send the notebook link
    await client.chat.postMessage({
      channel: dmResult.channel.id,
      text: `✅ Notebook "${escapeSlackMrkdwn(notebookName)}" created!\n\n<${notebookUrl}|${openLinkLabel}>`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Notebook created!*\n\n📓 *${escapeSlackMrkdwn(notebookName)}*`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📖 Open Notebook',
                emoji: true,
              },
              url: notebookUrl,
              action_id: 'open_notebook_link',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_You can also message me directly in this notebook._',
            },
          ],
        },
      ],
    });

    logger.info('[Slack Shortcut] Sent notebook created DM', { slackUserId, sessionId, notebookName });
  } catch (error) {
    logger.error('[Slack Shortcut] Error sending notebook created DM', { error, slackUserId });
  }
}

/**
 * Handle Quick Ask modal submission
 * Opens a DM with the user, posts the question, and processes it like a normal DM conversation
 */
export async function handleQuickAskSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string,
  passedWorkspaceId?: string
): Promise<ViewSubmissionResponse> {
  const { view, user } = payload;

  // Parse private_metadata to get userId and workspaceId
  let userId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const metadata = JSON.parse(view.private_metadata || '{}');
    userId = metadata.userId;
    workspaceId = metadata.workspaceId || passedWorkspaceId;
  } catch {
    logger.error('[Slack Shortcut] Failed to parse private_metadata');
    workspaceId = passedWorkspaceId;
  }

  if (!userId) {
    return {
      response_action: 'errors',
      errors: {
        question_block: 'Unable to identify user. Please try again.',
      },
    };
  }

  // Get question from form
  const question = view.state.values?.question_block?.question_input?.value?.trim();

  if (!question) {
    return {
      response_action: 'errors',
      errors: {
        question_block: 'Please enter a question.',
      },
    };
  }

  if (!botToken) {
    return {
      response_action: 'errors',
      errors: {
        question_block: 'Bot token not available. Please try again.',
      },
    };
  }

  // Close the modal immediately and process in the background
  // We need to respond within 3 seconds, so we kick off async processing
  processQuickAskInDM(user.id, userId, question, botToken, workspaceId).catch(error => {
    logger.error('[Slack Shortcut] Background quick ask processing failed', { error, userId });
  });

  // Modal closes automatically on success
  return {};
}

/**
 * Process quick ask by opening a DM and sending the question there
 * Uses async notification so Quest Processor can update the message with AI response
 */
async function processQuickAskInDM(
  slackUserId: string,
  b4mUserId: string,
  question: string,
  botToken: string,
  workspaceId?: string
): Promise<void> {
  const client = new WebClient(botToken);

  try {
    // Open a DM channel with the user
    const dmResult = await client.conversations.open({
      users: slackUserId,
    });

    if (!dmResult.ok || !dmResult.channel?.id) {
      logger.error('[Slack Shortcut] Failed to open DM channel', { slackUserId });
      return;
    }

    const dmChannelId = dmResult.channel.id;

    // Post the user's question as a message from the bot (formatted to show it's their question)
    const questionMessage = await client.chat.postMessage({
      channel: dmChannelId,
      text: `📝 *Quick Ask:*\n${escapeSlackMrkdwn(question)}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📝 *Quick Ask:*\n${escapeSlackMrkdwn(question)}`,
          },
        },
      ],
    });

    if (!questionMessage.ok || !questionMessage.ts) {
      logger.error('[Slack Shortcut] Failed to post question to DM', { slackUserId, dmChannelId });
      return;
    }

    // Post a "thinking" message that we'll update with the response
    const thinkingMessage = await client.chat.postMessage({
      channel: dmChannelId,
      text: '🤔 Thinking...',
      thread_ts: questionMessage.ts,
    });

    if (!thinkingMessage.ok || !thinkingMessage.ts) {
      logger.error('[Slack Shortcut] Failed to post thinking message', { slackUserId, dmChannelId });
      return;
    }

    // Get user's notebook and process the question
    const { User: UserModel } = getSlackDb();
    const dbUser = await (UserModel as any).findById(b4mUserId);
    if (!dbUser) {
      await client.chat.update({
        channel: dmChannelId,
        ts: thinkingMessage.ts,
        text: '❌ Unable to find your account. Please try again.',
      });
      return;
    }

    // SECURITY: Verify the userId from private_metadata matches the authenticated Slack user
    // This prevents attackers from modifying private_metadata to act as another user
    if (dbUser.slackSettings?.slackUserId !== slackUserId) {
      logger.warn('[Slack Shortcut] User mismatch in quick ask submission', {
        claimedUserId: b4mUserId,
        authenticatedSlackUserId: slackUserId,
        dbUserSlackId: dbUser.slackSettings?.slackUserId,
      });
      await client.chat.update({
        channel: dmChannelId,
        ts: thinkingMessage.ts,
        text: '❌ Unauthorized access.',
      });
      return;
    }

    // Get dependencies from DI registry
    const { Session: SessionModel, Quest: QuestModel, defineAbilitiesFor: defineAbilitiesForQuick } = getSlackDb();
    const { sessionManager: smQuick, eventBus, chatCompletionDefaults } = getSlackDeps();

    // Create ability for the user
    const ability = defineAbilitiesForQuick(dbUser);

    // Get or create default notebook
    let sessionId = dbUser.slackSettings?.defaultNotebookId;
    if (!sessionId) {
      const session = await (smQuick as any).createSession(
        b4mUserId,
        { name: `Slack Chat ${new Date().toLocaleDateString()}` },
        ability,
        { setLastNotebook: true }
      );
      sessionId = session.id;

      await (UserModel as any).findByIdAndUpdate(b4mUserId, {
        $set: { 'slackSettings.defaultNotebookId': sessionId },
      });
    } else {
      // Verify the notebook still exists
      const existingSession = await (SessionModel as any).findById(sessionId);
      if (!existingSession || existingSession.deletedAt) {
        const session = await (smQuick as any).createSession(
          b4mUserId,
          { name: `Slack Chat ${new Date().toLocaleDateString()}` },
          ability,
          { setLastNotebook: true }
        );
        sessionId = session.id;

        await (UserModel as any).findByIdAndUpdate(b4mUserId, {
          $set: { 'slackSettings.defaultNotebookId': sessionId },
        });
      }
    }

    // Ensure we have a valid sessionId
    if (!sessionId) {
      logger.error('[Slack Shortcut] No sessionId available after setup', { b4mUserId });
      await client.chat.update({
        channel: dmChannelId,
        ts: thinkingMessage.ts,
        text: '❌ Unable to create or find a notebook. Please try again.',
      });
      return;
    }

    // Add the message to the session (creates a quest)
    const createdQuest = await smQuick.addMessageToSession(
      b4mUserId,
      sessionId,
      {
        timestamp: new Date(),
        type: 'message',
        prompt: question,
        promptMeta: {
          performance: {},
          session: {
            id: sessionId,
            userId: b4mUserId,
          },
        },
      },
      ability
    );

    // Update quest with slackNotification for async response delivery
    if (workspaceId) {
      await (QuestModel as any).findByIdAndUpdate(createdQuest.id, {
        $set: {
          slackNotification: {
            workspaceId,
            channelId: dmChannelId,
            threadTs: questionMessage.ts,
            messageTs: thinkingMessage.ts,
          },
        },
      });
    }

    // Use ChatCompletionInvoke to properly trigger AI processing
    // This handles all the quest setup and EventBridge publishing correctly
    const { ChatCompletionInvoke } = await import('@bike4mind/services');
    const { SQSService } = await import('@bike4mind/utils');

    // any: defaultChatCompletionOptions provides remaining IChatCompletionServiceOptions fields at runtime
    const chatCompletion = new ChatCompletionInvoke({
      ...chatCompletionDefaults.defaultChatCompletionOptions,
      queue: new SQSService(),
      tokenizer: chatCompletionDefaults.getSharedTokenizer(logger),
      user: dbUser,
      sessionId,
      logger,
      invokeLambda: async (params: unknown) => {
        await eventBus.LLMEvents.CompletionStart.publish(params);
      },
    } as any);

    // Trigger AI response using the existing quest
    await chatCompletion.invoke({
      body: {
        params: {
          model: 'gpt-4.1-mini-2025-04-14',
          temperature: 0.7,
          top_p: 1,
          n: 1,
          stream: false,
          max_tokens: 4096,
          presence_penalty: 0,
          frequency_penalty: 0,
          logit_bias: {},
        },
        sessionId,
        message: question,
        messageFileIds: [],
        historyCount: 5,
        fabFileIds: [],
        questId: createdQuest.id, // Use existing quest
        enableQuestMaster: false,
        enableMementos: false,
        enableArtifacts: false,
        enableAgents: false,
      },
      userId: b4mUserId,
    });

    logger.info('[Slack Shortcut] Quick ask triggered for async processing', {
      slackUserId,
      b4mUserId,
      sessionId,
      questId: createdQuest.id,
      questionLength: question.length,
      hasSlackNotification: !!workspaceId,
    });
  } catch (error) {
    logger.error('[Slack Shortcut] Error processing quick ask in DM', { error, slackUserId, b4mUserId });

    // Try to notify the user of the error
    try {
      const dmResult = await client.conversations.open({ users: slackUserId });
      if (dmResult.ok && dmResult.channel?.id) {
        await client.chat.postMessage({
          channel: dmResult.channel.id,
          text: '❌ Sorry, there was an error processing your Quick Ask. Please try messaging me directly instead.',
        });
      }
    } catch {
      // Ignore error notification failure
    }
  }
}
