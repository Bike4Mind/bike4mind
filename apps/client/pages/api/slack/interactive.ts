import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { verifySlackRequest } from '@server/integrations/slack/slackWebhookVerification';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { WebClient } from '@slack/web-api';
import { User, Quest, connectDB, sessionRepository } from '@bike4mind/database';
import { SlackDevWorkspace } from '@bike4mind/database/infra';
import { createSession } from '@server/managers/sessionManager';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';
import { Config, isDevelopment } from '@server/utils/config';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import {
  JiraResource,
  ConfluenceResource,
  buildAttachmentDownloadButtons,
  AttachmentDownloadInfo,
  AppHomeBuilder,
  AppHomeDataService,
  SlackClient,
  SCHEDULE_MESSAGE_CALLBACK_ID,
  parseScheduleMessageSubmission,
  SlackAuditLogger,
  getClientIp,
  handleGlobalShortcut,
  handleCreateNotebookSubmission,
  handleQuickAskSubmission,
  CHANNEL_MODEL_CONFIG_CALLBACK_ID,
  ORG_MODEL_DEFAULTS_CALLBACK_ID,
  handleOrgDefaultsEdit,
  handleOrgModelDefaultsSubmission,
  handleChannelConfigAdd,
  handleChannelConfigEdit,
  handleChannelConfigRemove,
  handleChannelModelConfigSubmission,
  refreshAppHomeForAdmin,
  IMAGE_GEN_MODEL_ACTION_ID,
  getImageModelDisplayName,
  type ViewSubmissionPayload,
  type ViewSubmissionResponse,
} from '@bike4mind/slack';
import { JIRA_DELETE_ATTACHMENT, CONFLUENCE_DELETE_ATTACHMENT } from '@bike4mind/mcp/atlassian/constants';
import { executePendingAction, cancelPendingActionOnQuest } from '@server/utils/pendingActionExecutor';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { McpServer } from '@bike4mind/database/ai';
import { decryptToken } from '@server/security/tokenEncryption';
import { ImageModels, IUserDocument, McpServerName } from '@bike4mind/common';

dayjs.extend(utc);
dayjs.extend(timezone);

// Slack interactive payload schema
const SlackInteractivePayloadSchema = z.object({
  type: z.string(),
  user: z.object({
    id: z.string(),
    name: z.string().optional(),
    username: z.string().optional(),
    team_id: z.string().optional(),
  }),
  team: z.object({
    id: z.string(),
    domain: z.string(),
  }),
  channel: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
  message: z
    .object({
      ts: z.string(),
      thread_ts: z.string().optional(),
    })
    .optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        value: z.string().optional(),
        selected_option: z
          .object({
            value: z.string(),
          })
          .optional(),
        text: z
          .object({
            text: z.string(),
          })
          .optional(),
      })
    )
    .optional(),
  view: z
    .object({
      id: z.string().optional(),
      callback_id: z.string(),
      private_metadata: z.string().optional(),
      state: z.object({
        values: z.record(z.string(), z.any()),
      }),
    })
    .optional(),
  trigger_id: z.string().optional(),
  response_url: z.string().optional(),
  // For global shortcuts (/ menu) - callback_id is at top level
  callback_id: z.string().optional(),
});

// Needed when bodyParser is disabled.
async function getRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function findUserBySlackId(slackUserId: string) {
  const user = await User.findOne({
    'slackSettings.slackUserId': slackUserId,
  });
  return user;
}

async function updateUserSlackSettings(userId: string, slackSettings: any) {
  await User.findByIdAndUpdate(userId, { $set: { slackSettings } }, { new: true, upsert: false });
}

async function sendSlackResponse(responseUrl: string, message: any) {
  if (!responseUrl) return;

  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      Logger.error(`Failed to send Slack response: ${response.status}`);
    }
  } catch (error) {
    Logger.error('Error sending Slack response:', error);
  }
}

/**
 * Open a modal for App Home actions
 * Extracted to reduce code duplication between Help and Settings handlers
 */
async function openAppHomeModal(
  triggerId: string,
  botToken: string,
  title: string,
  blocks: any[]
): Promise<{ success: boolean; error?: any }> {
  try {
    const client = new WebClient(botToken);
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: title },
        close: { type: 'plain_text', text: 'Close' },
        blocks,
      },
    });
    return { success: true };
  } catch (error) {
    return { success: false, error };
  }
}

/**
 * Check if an interactive payload represents a successful model config change
 * that requires an App Home refresh.
 */
function isModelConfigChange(payload: Record<string, unknown>, response: Record<string, unknown>): boolean {
  // Don't refresh if the handler returned validation errors
  if (response?.response_action === 'errors') return false;

  const type = payload.type as string | undefined;
  const view = payload.view as { callback_id?: string } | undefined;
  const actions = payload.actions as Array<{ action_id?: string }> | undefined;

  if (type === 'view_submission' && view?.callback_id) {
    return view.callback_id === ORG_MODEL_DEFAULTS_CALLBACK_ID || view.callback_id === CHANNEL_MODEL_CONFIG_CALLBACK_ID;
  }

  if (actions?.[0]?.action_id?.startsWith('channel_config_remove_')) {
    return true;
  }

  return false;
}

/**
 * Handle modal view submissions
 */
async function handleViewSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string,
  workspaceId?: string
): Promise<ViewSubmissionResponse> {
  const { view } = payload;
  const callbackId = view?.callback_id;
  const logger = new Logger({ metadata: { component: 'ViewSubmission' } });

  // Handle Schedule Message modal submission
  if (callbackId === SCHEDULE_MESSAGE_CALLBACK_ID) {
    return await handleScheduleMessageSubmission(payload, botToken);
  }

  // Handle Channel Model Config modal submission
  if (callbackId === CHANNEL_MODEL_CONFIG_CALLBACK_ID) {
    return await handleChannelModelConfigSubmission(payload, botToken);
  }

  // Handle Org Model Defaults modal submission
  if (callbackId === ORG_MODEL_DEFAULTS_CALLBACK_ID) {
    return await handleOrgModelDefaultsSubmission(payload, botToken);
  }

  // Handle Create Notebook modal submission (from / shortcut)
  if (callbackId === 'create_notebook_modal') {
    return await handleCreateNotebookSubmission(payload, botToken);
  }

  // Handle Quick Ask modal submission (from / shortcut)
  if (callbackId === 'quick_ask_modal') {
    return await handleQuickAskSubmission(payload, botToken, workspaceId);
  }

  // Unknown modal
  logger.warn('[Slack Interactive] Unknown modal callback_id', { callbackId });
  return {};
}

/**
 * Handle Schedule Message modal submission
 */
async function handleScheduleMessageSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string
): Promise<ViewSubmissionResponse> {
  const { view, user } = payload;
  const logger = new Logger({ metadata: { component: 'ScheduleMessage' } });

  if (!botToken) {
    return {
      response_action: 'errors',
      errors: {
        message_block: 'Bot token not configured. Please contact your administrator.',
      },
    };
  }

  const submission = parseScheduleMessageSubmission(view.state.values, view.private_metadata || '{}');

  if ('error' in submission) {
    logger.warn('[Slack Interactive] Schedule message validation failed', { error: submission.error });
    return {
      response_action: 'errors',
      errors: {
        message_block: submission.error,
      },
    };
  }

  const { message, date, time, channelId } = submission;

  try {
    const slackClient = new SlackClient(botToken, logger);

    // Get user's timezone
    const userTimezone = await slackClient.getUserTimezone(user.id);

    // Combine date and time into a timestamp
    // Date is in YYYY-MM-DD format, time is in HH:MM format
    const dateTimeString = `${date} ${time}`;
    const scheduledDate = dayjs.tz(dateTimeString, 'YYYY-MM-DD HH:mm', userTimezone);

    // Validate the parsed date is valid
    if (!scheduledDate.isValid()) {
      return {
        response_action: 'errors',
        errors: {
          date_block: 'Invalid date or time format. Please try again.',
        },
      };
    }

    const timestamp = scheduledDate.unix();

    // Validate the time is in the future
    const now = Math.floor(Date.now() / 1000);
    if (timestamp <= now) {
      return {
        response_action: 'errors',
        errors: {
          date_block: 'Please select a future date and time.',
        },
      };
    }

    if (timestamp - now < 60) {
      return {
        response_action: 'errors',
        errors: {
          time_block: 'Messages must be scheduled at least 1 minute in advance.',
        },
      };
    }

    // Schedule the message
    const result = await slackClient.scheduleMessage({
      channel: channelId,
      text: message,
      postAt: timestamp,
    });

    if (!result) {
      return {
        response_action: 'errors',
        errors: {
          message_block: 'Failed to schedule message. Please try again.',
        },
      };
    }

    // Close the modal and send a confirmation message (ephemeral - only visible to the user)
    const formattedTime = scheduledDate.format('ddd, MMM D, YYYY [at] h:mm A');

    await slackClient.sendEphemeralMessage(
      {
        channel: channelId,
        text: `✅ Message scheduled for ${formattedTime} (${userTimezone})`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `✅ *Message Scheduled*\n\n` +
                `📅 *When:* ${formattedTime} (${userTimezone})\n` +
                `💬 *Message:* "${message.length > 100 ? message.substring(0, 100) + '...' : message}"\n` +
                `🔖 *ID:* \`${result.scheduledMessageId}\``,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Use \`/b4m schedule cancel ${result.scheduledMessageId}\` to cancel.`,
              },
            ],
          },
        ],
      },
      user.id
    );

    logger.info('[Slack Interactive] Message scheduled successfully', {
      scheduledMessageId: result.scheduledMessageId,
      postAt: timestamp,
      channelId,
    });

    // Return empty to close the modal
    return {};
  } catch (error) {
    logger.error('[Slack Interactive] Failed to schedule message:', error);
    return {
      response_action: 'errors',
      errors: {
        message_block: 'An error occurred while scheduling. Please try again.',
      },
    };
  }
}

// Handler for different interactive actions
async function handleInteractiveAction(
  payload: any,
  botToken?: string,
  prefetchedUser?: any,
  appName?: string,
  workspaceId?: string
): Promise<any> {
  const { type, user, actions, view, response_url, trigger_id } = payload;

  // Handle view_submission (modal form submissions)
  if (type === 'view_submission' && view?.callback_id) {
    return await handleViewSubmission(payload, botToken, workspaceId);
  }

  // Handle global shortcuts (/ menu)
  if (type === 'shortcut') {
    return await handleGlobalShortcut(payload, botToken, prefetchedUser, appName, workspaceId);
  }

  // Handle App Home actions first (these work even without linked account)
  // App Home buttons don't have response_url, so we use modals via trigger_id
  if (actions && actions.length > 0) {
    const action = actions[0];

    Logger.info('[Slack Interactive] Processing action', {
      actionId: action.action_id,
      hasResponseUrl: !!response_url,
      hasTriggerId: !!trigger_id,
      userId: user?.id,
    });

    if (action.action_id === 'app_home_help') {
      if (trigger_id && botToken) {
        const helpBlocks = [
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
                '*Reminders*\n' +
                '• `/b4m remind check report tomorrow` - Set\n' +
                '• View/manage in Slack\'s "Later" tab',
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
        ];

        const result = await openAppHomeModal(trigger_id, botToken, 'Help', helpBlocks);
        if (result.success) {
          Logger.info('[Slack Interactive] Help modal opened');
          return {};
        }
        Logger.error('[Slack Interactive] Failed to open help modal', result.error);
      }
      return { text: 'Help information is available when using the app.' };
    }

    if (action.action_id === 'app_home_settings') {
      // Use prefetched user (queried in parallel with workspace lookup) to save time
      const dbUser = prefetchedUser ?? (await findUserBySlackId(user.id));

      if (trigger_id && botToken) {
        const settingsBlocks = dbUser
          ? [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*Account Status*\n\n:white_check_mark: Your Slack account is linked.' },
              },
              { type: 'divider' },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'To manage your integrations (GitHub, Jira), visit your profile settings in the web app.',
                },
              },
            ]
          : [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*Link Your Account*\n\n:x: Your Slack account is not yet linked.' },
              },
              { type: 'divider' },
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text:
                    'To link your account:\n\n' +
                    '1. Log in to the web app\n' +
                    '2. Go to Profile Settings\n' +
                    '3. Connect your Slack account\n\n' +
                    'Once linked, you can use GitHub and Jira integrations.',
                },
              },
            ];

        const result = await openAppHomeModal(trigger_id, botToken, 'Settings', settingsBlocks);
        if (result.success) {
          Logger.info('[Slack Interactive] Settings modal opened');
          return {};
        }
        Logger.error('[Slack Interactive] Failed to open settings modal', result.error);
      }
      return { text: 'Settings are available when using the app.' };
    }

    // Handle org defaults and channel config actions (admin-only, require trigger_id for modals)
    if (action.action_id === 'org_defaults_edit') {
      return await handleOrgDefaultsEdit(user.id, trigger_id, botToken);
    }

    if (action.action_id === 'channel_config_add') {
      const slackTeamId = payload.team?.id;
      return await handleChannelConfigAdd(user.id, slackTeamId, trigger_id, botToken);
    }

    if (action.action_id.startsWith('channel_config_edit_')) {
      const channelId = action.action_id.replace('channel_config_edit_', '');
      const slackTeamId = payload.team?.id;
      return await handleChannelConfigEdit(user.id, channelId, slackTeamId, trigger_id, botToken);
    }

    if (action.action_id.startsWith('channel_config_remove_')) {
      const channelId = action.action_id.replace('channel_config_remove_', '');
      const slackTeamId = payload.team?.id;
      return await handleChannelConfigRemove(user.id, channelId, slackTeamId, botToken, appName);
    }
  }

  // Handle SRE approval actions (no linked account required - admin-only Slack action)
  if (actions && actions.length > 0) {
    const sreAction = actions[0];
    if (sreAction.action_id === 'sre_approve_fix' || sreAction.action_id === 'sre_reject_fix') {
      const { handleSreApprovalAction } = await import('@server/integrations/slack/sreSlackApproval');
      const { response, deferred } = await handleSreApprovalAction(
        sreAction.action_id,
        sreAction.value,
        user,
        response_url
      );
      // Stash deferred work - will be awaited after res.json()
      (payload as Record<string, unknown>).__sreDeferred = deferred;
      return response;
    }
  }

  // Find the user in our system (required for other actions)
  const dbUser = await findUserBySlackId(user.id);
  if (!dbUser) {
    Logger.error('[Slack Interactive] User not found', { slackUserId: user.id });
    return {
      text: '❌ User not found. Please link your Slack account in your profile settings.',
      response_type: 'ephemeral',
    };
  }

  if (actions && actions.length > 0) {
    const action = actions[0];

    // Handle app_home_notebook_{id} pattern (notebook click from App Home)
    if (action.action_id.startsWith('app_home_notebook_')) {
      const notebookId = action.action_id.replace('app_home_notebook_', '');
      Logger.info('[Slack Interactive] Notebook clicked from App Home', { notebookId, userId: dbUser.id });
      // For now, just acknowledge - the button has a URL that opens the web app
      return {};
    }

    switch (action.action_id) {
      case 'app_home_create_notebook':
        return await handleCreateNotebook(dbUser, user.id, response_url, botToken);

      case 'app_home_view_all':
        Logger.info('[Slack Interactive] View All clicked from App Home', { userId: dbUser.id });
        // Button has URL that opens web app directly
        return {};

      case 'app_home_refresh':
        return await handleAppHomeRefresh(dbUser, user.id, botToken, appName);

      case 'create_notebook':
        return await handleCreateNotebook(dbUser, user.id, response_url, botToken);

      case 'set_default_notebook':
        return await handleSetDefaultNotebook(dbUser, user.id, action.value);

      case 'toggle_auto_create':
        return await handleToggleAutoCreate(dbUser, user.id);

      case 'view_settings':
        return {
          text: '📊 Use `/notebook status` to view your settings',
          response_type: 'ephemeral',
        };

      case 'open_config_modal':
        if (response_url) {
          await sendSlackResponse(response_url, {
            text: '🔧 Configuration modal is not yet implemented. Use `/notebook` commands to manage your settings.',
            response_type: 'ephemeral',
          });
        }
        return {
          text: '🔧 Configuration modal is not yet implemented.',
          response_type: 'ephemeral',
        };

      case 'confirm_action':
        // Handle confirm button click for preview-first tools
        Logger.info('[Slack Interactive] Confirm button clicked', {
          questId: action.value,
          userId: dbUser.id,
        });
        if (!action.value) {
          return {
            text: '❌ Missing quest ID',
            replace_original: true,
            response_type: 'in_channel',
          };
        }
        // Execute and send result via response_url for reliable update
        if (response_url) {
          const confirmResult = await handleConfirmAction(dbUser, action.value);
          await sendSlackResponse(response_url, confirmResult);
          return {}; // Empty response since we sent via response_url
        }
        return await handleConfirmAction(dbUser, action.value);

      case 'cancel_action':
        // Handle cancel button click - use response_url for reliable update
        Logger.info('[Slack Interactive] Cancel button clicked', {
          questId: action.value,
          userId: dbUser.id,
        });
        if (!action.value) {
          return {
            text: '❌ Missing quest ID',
            replace_original: true,
            response_type: 'in_channel',
          };
        }
        if (response_url) {
          const cancelResult = await handleCancelAction(dbUser, action.value);
          await sendSlackResponse(response_url, cancelResult);
          return {}; // Empty response since we sent via response_url
        }
        return await handleCancelAction(dbUser, action.value);

      case 'modal_confirm_att_del': {
        Logger.info('[Slack Interactive] Modal delete button clicked', {
          value: action.value,
          userId: dbUser.id,
        });
        // view comes from the modal payload (block_actions inside a modal)
        const viewMeta = (payload as any).view;
        const viewId = viewMeta?.id;
        await handleAttachmentDeleteFromModal(dbUser, viewMeta?.private_metadata, viewId, botToken);
        return {};
      }

      default:
        // Handle image model selection (action_id: image_gen_model_0, image_gen_model_1, etc.)
        if (action.action_id.startsWith(IMAGE_GEN_MODEL_ACTION_ID)) {
          Logger.info('[Slack Interactive] Image model selected', {
            value: action.value,
            userId: dbUser.id,
          });

          if (!action.value) {
            return { text: '❌ Missing model selection', replace_original: true, response_type: 'in_channel' };
          }

          const imageGenResult = await handleImageModelSelection(
            dbUser,
            action.value,
            response_url,
            botToken,
            payload.channel?.id,
            payload.message?.thread_ts || payload.message?.ts,
            payload.message?.ts,
            payload.team?.id
          );
          if (response_url) {
            await sendSlackResponse(response_url, imageGenResult);
            return {};
          }
          return imageGenResult;
        }

        // Handle attachment overflow menu (action_id: attachment_menu_{attachmentId})
        if (action.action_id.startsWith('attachment_menu_')) {
          const selectedValue: string | undefined = action.selected_option?.value;
          Logger.info('[Slack Interactive] Attachment menu option selected', {
            actionId: action.action_id,
            selectedValue: selectedValue?.substring(0, 50),
            userId: dbUser.id,
          });

          if (selectedValue?.startsWith('download:')) {
            const buttonValue = selectedValue.slice('download:'.length);
            if (response_url && botToken) {
              const downloadResult = await handleAttachmentDownload(dbUser, buttonValue, botToken, response_url);
              await sendSlackResponse(response_url, downloadResult);
              return {};
            }
            return await handleAttachmentDownload(dbUser, buttonValue, botToken);
          }

          if (selectedValue?.startsWith('delete:')) {
            const buttonValue = selectedValue.slice('delete:'.length);
            if (trigger_id && botToken) {
              const result = await openAttachmentDeleteModal(buttonValue, trigger_id, botToken, response_url);
              return result;
            }
            return { text: '❌ Unable to open confirmation dialog', response_type: 'ephemeral' };
          }

          return {
            text: '❓ Unknown attachment action',
            response_type: 'ephemeral',
          };
        }

        // URL-only buttons (sre_view_github_issue, sre_review_github_issue_fix_loop)
        // Slack sends interaction payloads even for link buttons; just acknowledge.
        if (
          action.action_id.startsWith('sre_view_github_issue') ||
          action.action_id.startsWith('sre_review_github_issue')
        ) {
          return {};
        }

        Logger.error('[Slack Interactive] Unknown action_id', { actionId: action.action_id });
        return {
          text: '❓ Unknown action',
          response_type: 'ephemeral',
        };
    }
  }

  if (view && view.callback_id === 'notebook_settings_modal') {
    return await handleNotebookSettingsSubmission(dbUser, user.id, view.state.values);
  }

  return {
    text: '❓ Unknown interaction',
    response_type: 'ephemeral',
  };
}

/**
 * Handle App Home refresh button click
 */
async function handleAppHomeRefresh(dbUser: any, slackUserId: string, botToken?: string, appName?: string) {
  if (!botToken) {
    return {
      text: '❌ Unable to refresh - missing bot token',
      response_type: 'ephemeral',
    };
  }

  try {
    const refreshLogger = new Logger({ metadata: { component: 'AppHomeRefresh' } });
    const slackClient = new SlackClient(botToken, refreshLogger);

    // Fetch updated data
    const dataService = new AppHomeDataService();
    const appHomeData = await dataService.fetchAppHomeData(dbUser.id);

    // Check integration status
    const githubMcpServer = await McpServer.findOne({
      userId: dbUser.id,
      name: McpServerName.Github,
      enabled: true,
    });
    const hasGitHubConnected = !!githubMcpServer;
    const hasJiraConnected =
      !!dbUser.atlassianConnect?.accessToken && dbUser.atlassianConnect?.status !== 'needs_reconnect';

    // Get display name from Slack
    const slackUserInfo = await slackClient.getUserInfo(slackUserId);
    const displayName = slackUserInfo?.real_name || slackUserInfo?.name;

    // Build and publish updated view
    const homeBuilder = new AppHomeBuilder({
      slackUserId,
      displayName,
      hasGitHubConnected,
      hasJiraConnected,
      appName,
      notebooks: appHomeData.notebooks,
      stats: appHomeData.stats,
      isLinked: true,
      webAppBaseUrl: process.env.APP_URL,
    });

    await slackClient.publishHomeView(slackUserId, homeBuilder.build());
    Logger.info('[Slack Interactive] App Home refreshed via button', {
      userId: dbUser.id,
      notebookCount: appHomeData.notebooks.length,
    });

    return {}; // Empty response - the view update is the feedback
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to refresh App Home', {
      error,
      userId: dbUser.id,
    });
    return {
      text: '❌ Failed to refresh. Please try again.',
      response_type: 'ephemeral',
    };
  }
}

async function handleCreateNotebook(dbUser: any, slackUserId: string, responseUrl?: string, botToken?: string) {
  try {
    const notebookName = `Slack Chat - ${new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;

    const ability = { can: () => true };
    const newSession = await createSession(dbUser.id, { name: notebookName }, ability as any, {
      setLastNotebook: true,
    });

    // Update user's slack settings with the new default notebook
    const slackSettings = dbUser.slackSettings || {};
    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      defaultNotebookId: newSession.id,
    });

    // Refresh App Home view to show the new notebook
    if (botToken) {
      try {
        const refreshLogger = new Logger({ metadata: { component: 'AppHomeRefresh' } });
        const slackClient = new SlackClient(botToken, refreshLogger);

        // Fetch updated data
        const dataService = new AppHomeDataService();
        const appHomeData = await dataService.fetchAppHomeData(dbUser.id);

        // Check integration status
        const githubMcpServer = await McpServer.findOne({
          userId: dbUser.id,
          name: McpServerName.Github,
          enabled: true,
        });
        const hasGitHubConnected = !!githubMcpServer;
        const hasJiraConnected =
          !!dbUser.atlassianConnect?.accessToken && dbUser.atlassianConnect?.status !== 'needs_reconnect';

        // Get display name from Slack
        const slackUserInfo = await slackClient.getUserInfo(slackUserId);
        const displayName = slackUserInfo?.real_name || slackUserInfo?.name;

        // Build and publish updated view
        const homeBuilder = new AppHomeBuilder({
          slackUserId,
          displayName,
          hasGitHubConnected,
          hasJiraConnected,
          notebooks: appHomeData.notebooks,
          stats: appHomeData.stats,
          isLinked: true,
          webAppBaseUrl: process.env.APP_URL,
        });

        await slackClient.publishHomeView(slackUserId, homeBuilder.build());
        Logger.info('[Slack Interactive] App Home refreshed after notebook creation', {
          userId: dbUser.id,
          newNotebookId: newSession.id,
        });
      } catch (refreshError) {
        // Don't fail the whole operation if refresh fails
        Logger.warn('[Slack Interactive] Failed to refresh App Home after notebook creation', {
          error: refreshError,
          userId: dbUser.id,
        });
      }
    }

    const responseMessage = {
      text: `✅ Created new notebook: "${newSession.name}"`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Created new notebook:* "${newSession.name}"\n📝 *ID:* \`${newSession.id}\`\n\nThis notebook is now set as your default for Slack messages.`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📊 View Settings',
              },
              action_id: 'view_settings',
              style: 'primary',
            },
          ],
        },
      ],
      response_type: 'ephemeral',
    };

    // For interactive components, return the response directly (not via response_url)
    // Slack will display it immediately without duplication
    return responseMessage;
  } catch (error: any) {
    // DocumentDB doesn't support sparse unique indexes properly - it enforces uniqueness on
    // null slackMetadata, so a user can have only one notebook without it.
    if (error.code === 11000 && error.message?.includes('slackMetadata')) {
      Logger.warn('[Slack Interactive] DocumentDB sparse index limitation - user already has manual notebook', {
        userId: dbUser.id,
        errorCode: error.code,
      });

      const errorResponse = {
        replace_original: false, // Don't replace the status message, show new ephemeral message
        text: '⚠️ You already have a notebook.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '⚠️ *You already have a notebook.*\n\nUse `/notebook list` to switch, or create more in the web app.',
            },
          },
        ],
        response_type: 'ephemeral',
      };

      // Send via response_url (like Configure button does)
      if (responseUrl) {
        await sendSlackResponse(responseUrl, errorResponse);
        // Return empty response - Slack will show the response_url message instead
        return {
          response_type: 'ephemeral',
          replace_original: false,
          text: '', // Empty text to prevent display
        };
      }

      return errorResponse;
    }

    Logger.error('Error creating notebook:', error);
    return {
      replace_original: false,
      text: '❌ Failed to create notebook',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ *Failed to create notebook*\n\nPlease try again. If the problem persists, contact support.',
          },
        },
      ],
      response_type: 'ephemeral',
    };
  }
}

async function handleSetDefaultNotebook(dbUser: any, slackUserId: string, notebookId?: string) {
  if (!notebookId) {
    return {
      text: '❌ No notebook ID provided',
      response_type: 'ephemeral',
    };
  }

  try {
    const slackSettings = dbUser.slackSettings || {};
    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      defaultNotebookId: notebookId,
    });

    return {
      text: `✅ Default notebook set to: \`${notebookId}\``,
      response_type: 'ephemeral',
    };
  } catch (error) {
    Logger.error('Error setting default notebook:', error);
    return {
      text: '❌ Failed to set default notebook',
      response_type: 'ephemeral',
    };
  }
}

async function handleToggleAutoCreate(dbUser: any, slackUserId: string) {
  try {
    const slackSettings = dbUser.slackSettings || {};
    const newAutoCreate = !slackSettings.autoCreateNotebook;

    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      autoCreateNotebook: newAutoCreate,
    });

    return {
      text: `🤖 Auto-create notebooks: ${newAutoCreate ? 'Enabled' : 'Disabled'}`,
      response_type: 'ephemeral',
    };
  } catch (error) {
    Logger.error('Error toggling auto-create:', error);
    return {
      text: '❌ Failed to toggle auto-create setting',
      response_type: 'ephemeral',
    };
  }
}

async function handleNotebookSettingsSubmission(dbUser: any, slackUserId: string, values: any) {
  try {
    const notebookId = values.notebook_block?.notebook_input?.value;
    const autoCreate = values.auto_create_block?.auto_create_select?.selected_option?.value === 'true';
    const namePrefix = values.name_prefix_block?.name_prefix_input?.value || 'Slack Chat';

    const slackSettings = dbUser.slackSettings || {};
    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      defaultNotebookId: notebookId,
      autoCreateNotebook: autoCreate,
      notebookNamePrefix: namePrefix,
    });

    return {
      text: '✅ Notebook settings updated successfully!',
      response_type: 'ephemeral',
    };
  } catch (error) {
    Logger.error('Error updating notebook settings:', error);
    return {
      text: '❌ Failed to update settings',
      response_type: 'ephemeral',
    };
  }
}

/** Slack interactive response shape for action handlers */
interface SlackInteractiveResponse {
  text: string;
  replace_original?: boolean;
  response_type?: 'in_channel' | 'ephemeral';
}

/**
 * Handle image model selection from the picker UI
 * Parses questId:modelId from the button value, triggers image generation
 */
async function handleImageModelSelection(
  dbUser: IUserDocument,
  buttonValue: string,
  response_url: string | undefined,
  botToken: string | undefined,
  channelId?: string,
  threadTs?: string,
  messageTs?: string,
  teamId?: string
): Promise<SlackInteractiveResponse> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-image-gen' } });

  // Guard: channelId and threadTs are required for slackNotification (schema requires them)
  if (!channelId || !threadTs) {
    logger.error('🎨 [IMAGE-GEN] Missing channelId or threadTs for image generation', { channelId, threadTs });
    return {
      text: '❌ Unable to start image generation — missing channel context. Please try again.',
      replace_original: false,
      response_type: 'ephemeral',
    };
  }

  // Parse "questId:modelId" from button value
  const colonIdx = buttonValue.indexOf(':');
  if (colonIdx === -1) {
    return { text: '❌ Invalid model selection', replace_original: true, response_type: 'in_channel' };
  }

  const questId = buttonValue.substring(0, colonIdx);
  const rawModelId = buttonValue.substring(colonIdx + 1);

  // Validate model against ImageModels enum
  if (!Object.values(ImageModels).includes(rawModelId as ImageModels)) {
    logger.warn('🎨 [IMAGE-GEN] Invalid model ID from button payload', { rawModelId, questId });
    return { text: '❌ Invalid model selection', replace_original: true, response_type: 'in_channel' };
  }
  const modelId = rawModelId as ImageModels;

  logger.info('🎨 [IMAGE-GEN] Model selected', { questId, modelId, userId: dbUser.id });

  // Look up the quest to get the pending image generation prompt from pendingAction
  const quest = await Quest.findById(questId);
  const pendingAction = quest?.pendingAction;
  const pendingImgParams =
    pendingAction?.tool === 'image_generation'
      ? (pendingAction.params as { prompt?: string; userId?: string })
      : undefined;
  if (!pendingImgParams?.prompt) {
    logger.warn('🎨 [IMAGE-GEN] No pending image generation found', { questId });
    return {
      text: '❌ This image generation request has expired. Please try again.',
      replace_original: true,
      response_type: 'in_channel',
    };
  }

  // Verify the clicking user owns this image generation request
  if (pendingImgParams.userId && pendingImgParams.userId !== dbUser.id) {
    logger.warn('🎨 [IMAGE-GEN] Unauthorized model picker click', {
      questId,
      questOwner: pendingImgParams.userId,
      clickingUser: dbUser.id,
    });
    return {
      text: '❌ Only the person who requested this image can select a model.',
      replace_original: false,
      response_type: 'ephemeral',
    };
  }

  const { prompt } = pendingImgParams;
  const modelDisplayName = getImageModelDisplayName(modelId);

  // Clear pendingAction (image generation request consumed)
  await Quest.findByIdAndUpdate(questId, { $unset: { pendingAction: 1 } });

  // Get workspace info from the quest's session to find the workspace
  const { slackDevWorkspaceRepository } = await import('@bike4mind/database');

  // Find the SlackDevWorkspace by team ID - Quest Processor needs workspace.id to look up bot token later
  const workspace = teamId ? await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(teamId) : null;

  if (!workspace?.slackBotToken) {
    logger.error('🎨 [IMAGE-GEN] No workspace found for image gen', { userId: dbUser.id });
    return {
      text: '❌ Unable to generate image — workspace not found.',
      replace_original: true,
      response_type: 'in_channel',
    };
  }

  // Find the notebook for this quest (quest is non-null - guarded by pendingAction check above)
  const notebookId = quest!.sessionId;

  // Update the picker message to show generation status (preserve the prompt so it doesn't disappear)
  const displayPrompt = prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt;
  const statusText = `🎨 *Image Generation*\n> ${displayPrompt}\n\nGenerating with ${modelDisplayName}... This may take a minute or two.`;

  // Trigger image generation via shared helper
  try {
    const { triggerImageGeneration } = await import('@bike4mind/slack');
    await triggerImageGeneration({
      notebookId,
      userId: dbUser.id,
      prompt,
      model: modelId,
      questId,
      slackNotification: {
        workspaceId: workspace.id,
        channelId,
        threadTs,
        messageTs: messageTs || threadTs,
      },
    });

    logger.info('🎨 [IMAGE-GEN] Generation triggered from interactive', {
      questId,
      model: modelId,
      channelId,
    });
  } catch (error) {
    logger.error('🎨 [IMAGE-GEN] Failed to trigger generation', {
      error: error instanceof Error ? error.message : String(error),
      questId,
    });
    return {
      text: '❌ Something went wrong starting image generation. Please try again.',
      replace_original: true,
      response_type: 'in_channel',
    };
  }

  return {
    text: statusText,
    replace_original: true,
    response_type: 'in_channel',
  };
}

/**
 * Handle confirm button click - execute the action from questId
 */
async function handleConfirmAction(dbUser: any, questId: string): Promise<any> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-confirm' } });

  logger.info('[Slack Interactive] Processing confirm action', {
    userId: dbUser.id,
    questId,
  });

  const result = await executePendingAction(questId, dbUser, logger);

  return {
    text: result.success ? result.message : `❌ ${result.message}`,
    replace_original: true,
    response_type: 'in_channel',
  };
}

/**
 * Handle cancel button click - clears pendingAction from the Quest
 */
async function handleCancelAction(_dbUser: any, questId: string): Promise<any> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-cancel' } });

  const result = await cancelPendingActionOnQuest(questId, logger);

  return {
    text: `👍 ${result.message}`,
    replace_original: true,
    response_type: 'in_channel',
  };
}

/**
 * Handle attachment download button click
 * Downloads file from Jira/Confluence and uploads it directly to Slack
 */
async function handleAttachmentDownload(
  dbUser: any,
  buttonValue: string | undefined,
  botToken?: string,
  _responseUrl?: string
): Promise<any> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-attachment-download' } });

  if (!buttonValue) {
    return {
      text: '❌ Missing attachment information',
      response_type: 'ephemeral',
    };
  }

  // Parse compact reference: "questId:index"
  const [questId, indexStr] = buttonValue.split(':');
  const index = parseInt(indexStr, 10);
  if (!questId || isNaN(index)) {
    logger.error('[Slack Interactive] Failed to parse attachment button value', { buttonValue });
    return {
      text: '❌ Invalid attachment data',
      response_type: 'ephemeral',
    };
  }

  // Look up Quest to get attachment data
  const quest = await Quest.findById(questId);
  // any: attachmentList is defined in the schema but not yet typed on the interface
  const questAny = quest as any;
  const attachmentEntry = questAny?.attachmentList?.attachments?.[index];
  if (!quest || !questAny?.attachmentList || !attachmentEntry) {
    logger.error('[Slack Interactive] Quest or attachment not found', { questId, index });
    return {
      text: '❌ Attachment data expired. Please list attachments again.',
      response_type: 'ephemeral',
    };
  }

  const { source } = questAny.attachmentList;
  const { id: attachmentId, filename, emoji, sizeFormatted } = attachmentEntry;
  const sessionId = quest.sessionId;

  logger.info('[Slack Interactive] Processing attachment download', {
    source,
    attachmentId,
    filename,
    sessionId,
    userId: dbUser.id,
  });

  // Get session to find Slack metadata
  const session = await sessionRepository.findById(sessionId);
  if (!session?.slackMetadata) {
    logger.error('[Slack Interactive] Session not found or missing Slack metadata', { sessionId });
    return {
      text: '❌ Session context not found. Please try listing attachments again.',
      response_type: 'ephemeral',
    };
  }

  const { channelId, threadTs } = session.slackMetadata;

  if (!botToken) {
    logger.error('[Slack Interactive] Missing bot token for attachment upload');
    return {
      text: '❌ Unable to upload - missing Slack configuration',
      response_type: 'ephemeral',
    };
  }

  try {
    const slackClient = new SlackClient(botToken, logger);

    // Create appropriate resource for MCP call
    const resource = source === 'jira' ? new JiraResource(dbUser, logger) : new ConfluenceResource(dbUser, logger);

    // Get MCP env variables
    const envVariables = await resource.getMcpEnvVariables();

    // Determine MCP tool name
    const toolName = source === 'jira' ? 'jira_download_attachment' : 'confluence_download_attachment';

    logger.info('[Slack Interactive] Calling MCP download tool', {
      toolName,
      attachmentId,
    });

    // Download the attachment via MCP
    const result = await invokeMcpHandler<any>({
      envVariables,
      name: 'atlassian',
      toolName,
      toolArgs: { attachmentId },
      action: 'callTool',
    });

    // Parse result
    let fileData: any = result;
    if (typeof result === 'string') {
      try {
        fileData = JSON.parse(result);
      } catch {
        fileData = { error: result };
      }
    }

    // Handle nested content structure from MCP
    if (fileData?.content?.[0]?.text) {
      try {
        fileData = JSON.parse(fileData.content[0].text);
      } catch {
        fileData = { error: 'Failed to parse download result' };
      }
    }

    if (fileData?.error || !fileData?.content) {
      logger.error('[Slack Interactive] Attachment download failed', {
        error: fileData?.error,
        hasContent: !!fileData?.content,
      });
      return {
        text: `❌ Failed to download: ${fileData?.error || 'Unknown error'}`,
        response_type: 'ephemeral',
        replace_original: false, // Keep the download buttons visible
      };
    }

    // Upload to Slack
    const sourceLabel = source === 'jira' ? 'Jira' : 'Confluence';
    const uploadResult = await slackClient.uploadFile({
      channel: channelId,
      filename: fileData.filename || filename,
      content: Buffer.from(fileData.content, 'base64'),
      threadTs,
      initialComment: `${emoji} Downloaded from ${sourceLabel}: ${filename} (${sizeFormatted})`,
    });

    if (uploadResult.success) {
      logger.info('[Slack Interactive] Attachment uploaded to Slack', {
        fileId: uploadResult.fileId,
        filename,
      });
      return {
        text: `✅ ${emoji} *${filename}* uploaded to this channel`,
        response_type: 'ephemeral',
        replace_original: false, // Keep the download buttons visible for other files
      };
    } else {
      return {
        text: `❌ Failed to upload file to Slack`,
        response_type: 'ephemeral',
        replace_original: false, // Keep the download buttons visible
      };
    }
  } catch (error) {
    logger.error('[Slack Interactive] Attachment download/upload failed', {
      error: error instanceof Error ? error.message : String(error),
      attachmentId,
      filename,
    });
    return {
      text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      response_type: 'ephemeral',
    };
  }
}

/**
 * Open a confirmation modal before deleting an attachment.
 * Uses Slack views.open to show a proper modal dialog.
 */
async function openAttachmentDeleteModal(
  buttonValue: string,
  triggerId: string,
  botToken: string,
  responseUrl?: string
): Promise<Record<string, unknown>> {
  const [questId, indexStr] = buttonValue.split(':');
  const index = parseInt(indexStr, 10);
  if (!questId || isNaN(index)) {
    return { text: '❌ Invalid attachment data', response_type: 'ephemeral' };
  }

  const quest = await Quest.findById(questId);
  // any: attachmentList is defined in the schema but not yet typed on the interface
  const questAny = quest as any;
  const att = questAny?.attachmentList?.attachments?.[index];
  if (!quest || !questAny?.attachmentList || !att) {
    return { text: '❌ Attachment data expired. Please list attachments again.', response_type: 'ephemeral' };
  }

  const { source, pageId, pageTitle, issueKey } = questAny.attachmentList;
  const confluenceLabel = pageTitle ? `Confluence page "${pageTitle}"` : `Confluence page ${pageId || 'unknown'}`;
  const sourceContext = source === 'jira' ? `Jira ticket ${issueKey || 'unknown'}` : confluenceLabel;

  try {
    const client = new WebClient(botToken);
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'confirm_att_del_modal',
        title: { type: 'plain_text', text: 'Delete Attachment' },
        private_metadata: JSON.stringify({ buttonValue, responseUrl }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${att.filename}*\n\n${att.emoji} This will permanently remove the attachment from ${sourceContext}.\n\n_This action cannot be undone._`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Delete' },
                style: 'danger',
                action_id: 'modal_confirm_att_del',
                value: buttonValue,
              },
            ],
          },
        ],
      },
    });
    return {};
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to open delete confirmation modal', { error });
    return { text: '❌ Failed to open confirmation dialog', response_type: 'ephemeral' };
  }
}

/**
 * Handle attachment delete from the modal's danger button (block_actions).
 * Updates the modal to show progress, processes deletion, and refreshes the attachment list.
 */
async function handleAttachmentDeleteFromModal(
  // any: dbUser is IUserDocument from Mongoose
  dbUser: any,
  privateMetadata: string | undefined,
  viewId: string | undefined,
  botToken?: string
): Promise<void> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-attachment-delete-modal' } });

  let buttonValue: string | undefined;
  let responseUrl: string | undefined;
  try {
    const metadata = JSON.parse(privateMetadata || '{}');
    buttonValue = metadata.buttonValue;
    responseUrl = metadata.responseUrl;
  } catch {
    logger.error('[Slack Interactive] Failed to parse private_metadata for delete modal');
    return;
  }

  if (!buttonValue) {
    logger.error('[Slack Interactive] Missing buttonValue in delete modal metadata');
    return;
  }

  // Update modal to show deletion in progress
  if (viewId && botToken) {
    try {
      const client = new WebClient(botToken);
      await client.views.update({
        view_id: viewId,
        view: {
          type: 'modal',
          callback_id: 'confirm_att_del_modal',
          title: { type: 'plain_text', text: 'Delete Attachment' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '🔄 Deleting attachment...' },
            },
          ],
        },
      });
    } catch {
      // Non-fatal: modal may have been dismissed
    }
  }

  // Process delete
  const result = await handleAttachmentDelete(dbUser, buttonValue);
  const isSuccess = typeof result.text === 'string' && !result.text.startsWith('❌');

  // Update modal with result
  if (viewId && botToken) {
    try {
      const client = new WebClient(botToken);
      await client.views.update({
        view_id: viewId,
        view: {
          type: 'modal',
          callback_id: 'confirm_att_del_modal',
          title: { type: 'plain_text', text: 'Delete Attachment' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: result.text as string },
            },
          ],
        },
      });
    } catch {
      // Non-fatal
    }
  }

  // After successful deletion, update the original message with refreshed attachment list
  if (isSuccess && responseUrl) {
    try {
      const [questId, indexStr] = buttonValue.split(':');
      const deletedIndex = parseInt(indexStr, 10);
      const quest = await Quest.findById(questId);
      // any: attachmentList is defined in the schema but not yet typed on the interface
      const questAny = quest as any;

      if (quest && questAny?.attachmentList?.attachments) {
        // Remove the deleted attachment and save
        const remainingAttachments = questAny.attachmentList.attachments.filter(
          (_: unknown, i: number) => i !== deletedIndex
        );
        questAny.attachmentList.attachments = remainingAttachments;
        await quest.save();

        if (remainingAttachments.length > 0) {
          // Rebuild attachment list blocks
          const { source, issueKey, pageId } = questAny.attachmentList;
          const attachmentInfos: AttachmentDownloadInfo[] = remainingAttachments.map((att: any) => ({
            source,
            attachmentId: att.id,
            filename: att.filename,
            emoji: att.emoji,
            sizeFormatted: att.sizeFormatted,
            author: att.author,
            issueKey,
            pageId,
          }));

          const updatedBlocks = [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: result.text as string },
            },
            { type: 'divider' },
            ...buildAttachmentDownloadButtons(attachmentInfos, questId),
          ];

          await sendSlackResponse(responseUrl, {
            blocks: updatedBlocks,
            text: result.text,
            replace_original: true,
          });
        } else {
          // No attachments left
          await sendSlackResponse(responseUrl, {
            text: result.text as string,
            replace_original: true,
          });
        }
      }
    } catch (updateErr) {
      logger.warn('[Slack Interactive] Failed to update attachment list after deletion', {
        error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      });
      // Fall back to simple success message
      await sendSlackResponse(responseUrl, { ...result, replace_original: true });
    }
  } else if (responseUrl) {
    // Error case - send error message
    await sendSlackResponse(responseUrl, { ...result, replace_original: false });
  }
}

// any: dbUser is IUserDocument from Mongoose, matching handleAttachmentDownload's signature
async function handleAttachmentDelete(dbUser: any, buttonValue: string | undefined): Promise<Record<string, unknown>> {
  const logger = new Logger({ metadata: { component: 'slack-interactive-attachment-delete' } });

  if (!buttonValue) {
    return {
      text: '❌ Missing attachment information',
      response_type: 'ephemeral',
    };
  }

  // Parse compact reference: "questId:index"
  const [questId, indexStr] = buttonValue.split(':');
  const index = parseInt(indexStr, 10);
  if (!questId || isNaN(index)) {
    logger.error('[Slack Interactive] Failed to parse attachment delete button value', { buttonValue });
    return {
      text: '❌ Invalid attachment data',
      response_type: 'ephemeral',
    };
  }

  // Look up Quest to get attachment data
  const quest = await Quest.findById(questId);
  // any: attachmentList is defined in the schema but not yet typed on the interface
  const questAny = quest as any;
  const attachmentEntry = questAny?.attachmentList?.attachments?.[index];
  if (!quest || !questAny?.attachmentList || !attachmentEntry) {
    logger.error('[Slack Interactive] Quest or attachment not found', { questId, index });
    return {
      text: '❌ Attachment data expired. Please list attachments again.',
      response_type: 'ephemeral',
    };
  }

  const { source } = questAny.attachmentList;
  const { id: attachmentId, filename, emoji } = attachmentEntry;

  logger.info('[Slack Interactive] Processing attachment deletion', {
    source,
    attachmentId,
    filename,
    userId: dbUser?.id,
  });

  try {
    const resource = source === 'jira' ? new JiraResource(dbUser, logger) : new ConfluenceResource(dbUser, logger);
    const envVariables = await resource.getMcpEnvVariables();
    const toolName = source === 'jira' ? JIRA_DELETE_ATTACHMENT : CONFLUENCE_DELETE_ATTACHMENT;

    await invokeMcpHandler({
      envVariables,
      name: 'atlassian',
      toolName,
      toolArgs: { attachmentId, confirmed: true, _executeFromButton: true },
      action: 'callTool',
    });

    // For Confluence: clean up page content to remove macros referencing the deleted attachment
    if (source === 'confluence' && questAny.attachmentList.pageId) {
      try {
        await cleanupConfluencePageContent(envVariables, questAny.attachmentList.pageId, filename, logger);
      } catch (cleanupError) {
        logger.warn('[Slack Interactive] Failed to clean up Confluence page content (non-fatal)', {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          pageId: questAny.attachmentList.pageId,
          filename,
        });
      }
    }

    const confluenceLabel = questAny.attachmentList.pageTitle
      ? `Confluence page *"${questAny.attachmentList.pageTitle}"*`
      : `Confluence page *${questAny.attachmentList.pageId || ''}*`;
    const sourceContext =
      source === 'jira' ? `Jira ticket *${questAny.attachmentList.issueKey || ''}*` : confluenceLabel;

    return {
      text: `🗑️ ${emoji} *${filename}* has been deleted from ${sourceContext}`,
      response_type: 'ephemeral',
      replace_original: true,
    };
  } catch (error) {
    logger.error('[Slack Interactive] Attachment deletion failed', {
      error: error instanceof Error ? error.message : String(error),
      attachmentId,
      filename,
    });
    return {
      text: `❌ Failed to delete *${filename}*: ${error instanceof Error ? error.message : 'Unknown error'}`,
      response_type: 'ephemeral',
      replace_original: true,
    };
  }
}

/**
 * Remove Confluence storage format macros that reference a specific attachment.
 * Handles both <ac:image> tags and <ac:structured-macro ac:name="view-file"> tags.
 */
function removeAttachmentMacros(content: string, filename: string): string {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove <ac:image> tags referencing the attachment (optionally wrapped in <p>)
  const imageRegex = new RegExp(
    `(?:<p>\\s*)?<ac:image[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>\\s*</ac:image>(?:\\s*</p>)?`,
    'g'
  );
  // Remove <ac:structured-macro ac:name="view-file"> tags referencing the attachment
  const macroRegex = new RegExp(
    `<ac:structured-macro[^>]*ac:name="view-file"[^>]*>[\\s\\S]*?<ri:attachment[^>]*ri:filename="${escaped}"[^/]*/?>` +
      `[\\s\\S]*?</ac:structured-macro>`,
    'g'
  );
  let cleaned = content.replace(imageRegex, '');
  cleaned = cleaned.replace(macroRegex, '');
  return cleaned;
}

/**
 * After deleting a Confluence attachment, clean up the page content
 * to remove inline macros (image previews, view-file macros) that reference it.
 */
async function cleanupConfluencePageContent(
  envVariables: Array<{ key: string; value: string }>,
  pageId: string,
  filename: string,
  logger: Logger
): Promise<void> {
  const getEnv = (name: string) => envVariables.find(v => v.key === name)?.value || '';
  const accessToken = getEnv('ATLASSIAN_ACCESS_TOKEN');
  const cloudId = getEnv('ATLASSIAN_CLOUD_ID');

  if (!accessToken || !cloudId) {
    logger.warn('[Confluence Cleanup] Missing credentials, skipping page cleanup');
    return;
  }

  const baseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // Fetch page with raw storage format content
  const pageRes = await fetch(`${baseUrl}/pages/${pageId}?body-format=storage`, { headers });
  if (!pageRes.ok) {
    logger.warn(`[Confluence Cleanup] Failed to fetch page ${pageId}: ${pageRes.status}`);
    return;
  }

  const page = await pageRes.json();
  const storageContent = page?.body?.storage?.value;
  if (!storageContent) {
    logger.info('[Confluence Cleanup] Page has no storage content to clean');
    return;
  }

  const cleanedContent = removeAttachmentMacros(storageContent, filename);
  if (cleanedContent === storageContent) {
    logger.info('[Confluence Cleanup] No macros found referencing deleted attachment');
    return;
  }

  const version = page?.version?.number;
  if (typeof version !== 'number') {
    logger.warn('[Confluence Cleanup] Could not determine page version');
    return;
  }

  const updateRes = await fetch(`${baseUrl}/pages/${pageId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      id: pageId,
      title: page.title,
      body: { value: cleanedContent, representation: 'storage' },
      status: 'current',
      version: { number: version + 1 },
    }),
  });

  if (!updateRes.ok) {
    const errorText = await updateRes.text().catch(() => '');
    logger.warn(`[Confluence Cleanup] Failed to update page ${pageId}: ${updateRes.status} ${errorText}`);
    return;
  }

  logger.info(`[Confluence Cleanup] Removed macros for "${filename}" from page ${pageId}`);
}

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  // Log immediately to confirm handler is reached
  Logger.info('[Slack Interactive] Handler called', {
    method: req.method,
    url: req.url,
  });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Connect to database
  try {
    const mongoUri = Config.MONGODB_URI.replace('%STAGE%', Config.STAGE);
    await connectDB(mongoUri);
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to connect to MongoDB', error);
    return res.status(500).json({ error: 'Database connection failed' });
  }

  // Get raw body for signature verification (bodyParser is disabled)
  const rawBody = await getRawBody(req);
  if (!rawBody) {
    return res.status(400).json({ error: 'No body provided' });
  }

  // Parse URL-encoded body (Slack sends: payload=<url-encoded-json>)
  const urlParams = new URLSearchParams(rawBody);
  const payloadString = urlParams.get('payload');
  if (!payloadString) {
    Logger.error('[Slack Interactive] No payload in body');
    return res.status(400).json({ error: 'No payload provided' });
  }

  // Parse payload JSON to get team_id for workspace lookup
  let parsedPayload: any;
  try {
    parsedPayload = JSON.parse(payloadString);
  } catch (e) {
    Logger.error('[Slack Interactive] Failed to parse payload');
    return res.status(400).json({ error: 'Invalid payload format' });
  }

  const teamId = parsedPayload.team?.id;
  const apiAppId = parsedPayload.api_app_id;
  const actionId = parsedPayload.actions?.[0]?.action_id;
  const slackUserId = parsedPayload.user?.id;

  Logger.info('[Slack Interactive] Received request', {
    teamId,
    apiAppId,
    type: parsedPayload.type,
    actionId,
  });

  // Start user lookup early for app_home_settings (parallelize with workspace lookup)
  // This helps stay within trigger_id's 3-second expiration window
  const userLookupPromise =
    actionId === 'app_home_settings' && slackUserId ? findUserBySlackId(slackUserId) : Promise.resolve(null);

  // Find workspace with all credentials in a single query for speed (trigger_id expires in 3s)
  let workspace = null;

  if (apiAppId) {
    workspace = await SlackDevWorkspace.findOne({ slackAppId: apiAppId, isActive: true }).select(
      '+slackClientId +slackClientSecret +slackOAuthSigningSecret +slackBotToken slackBotName'
    );
  }

  // Fallback: find by team_id
  if (!workspace && teamId) {
    workspace = await SlackDevWorkspace.findOne({ slackTeamId: teamId, isActive: true }).select(
      '+slackClientId +slackClientSecret +slackOAuthSigningSecret +slackBotToken slackBotName'
    );
  }

  // Fallback to first active workspace if not found (dev mode only for testing)
  if (!workspace && isDevelopment()) {
    workspace = await SlackDevWorkspace.findOne({ isActive: true }).select(
      '+slackClientId +slackClientSecret +slackOAuthSigningSecret +slackBotToken slackBotName'
    );
  }

  // Await user lookup that was started in parallel
  const prefetchedUser = await userLookupPromise;

  if (!workspace) {
    Logger.error('[Slack Interactive] No Slack workspace found', { teamId, apiAppId });
    return res.status(500).json({
      error: 'Slack workspace not configured. Please create a Slack app via the admin panel.',
    });
  }

  const signingSecret = workspace.slackOAuthSigningSecret;
  if (!signingSecret) {
    Logger.error('[Slack Interactive] Signing secret not configured for workspace', {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
    return res.status(500).json({
      error: 'Slack signing secret not configured for workspace.',
    });
  }

  Logger.info('[Slack Interactive] Using workspace', {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    signingSecretExists: !!signingSecret,
  });

  // Verify Slack request: timestamp freshness + HMAC signature
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

  // Create integration audit logger for webhook verification tracking
  const integrationAuditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'webhook',
      integrationName: 'slack',
      action: 'webhook_interactive',
      requestId: randomUUID().split('-')[0],
      metadata: { teamId, apiAppId },
    },
    req
  );

  const verifyResult = verifySlackRequest(rawBody, timestamp, signature, signingSecret);
  if (!verifyResult.valid) {
    Logger.warn('[Slack Interactive] Request verification failed', {
      reason: verifyResult.reason,
      teamId,
      apiAppId,
      workspaceName: workspace.name,
    });
    integrationAuditLogger.failure(verifyResult.reason);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  integrationAuditLogger.success();

  try {
    const payload = JSON.parse(payloadString);
    const validatedPayload = SlackInteractivePayloadSchema.safeParse(payload);

    if (!validatedPayload.success) {
      Logger.error('[Slack Interactive] Invalid payload:', validatedPayload.error);
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const { user, team, actions, view } = validatedPayload.data;
    const actionId = actions?.[0]?.action_id || view?.callback_id || 'unknown';

    // Create audit logger for this interaction
    const auditLogger = SlackAuditLogger.create({
      eventType: 'interaction',
      slackUserId: user.id,
      slackTeamId: team.id,
      action: actionId,
      metadata: {
        interactionType: validatedPayload.data.type,
        actionValue: actions?.[0]?.value,
      },
      ipAddress: getClientIp(req),
    });

    const appName = workspace.slackBotName || workspace.name;
    const botToken = decryptToken(workspace.slackBotToken) ?? '';
    Logger.info('[Slack Interactive] Calling handler', {
      hasBotToken: !!botToken,
      hasPrefetchedUser: !!prefetchedUser,
    });

    try {
      const response = await handleInteractiveAction(
        validatedPayload.data,
        botToken,
        prefetchedUser,
        appName,
        workspace.id
      );

      auditLogger.success();
      res.json(response);

      // Post-response: refresh App Home after model config changes.
      // Awaited (not fire-and-forget) so the promise completes before
      // the Lambda handler returns - prevents Lambda freeze from
      // orphaning the refresh.
      if (isModelConfigChange(validatedPayload.data, response)) {
        const slackUserId = validatedPayload.data.user?.id;
        const slackTeamId = validatedPayload.data.team?.id;
        if (slackUserId && slackTeamId && botToken) {
          try {
            await refreshAppHomeForAdmin(slackUserId, slackTeamId, botToken, appName);
          } catch (refreshErr) {
            Logger.warn('[Slack Interactive] Post-response App Home refresh failed', { error: refreshErr });
          }
        }
      }

      // Post-response: await SRE deferred work (approval processing).
      // Same pattern as refreshAppHomeForAdmin - prevents Lambda freeze from killing it.
      const sreDeferred = (validatedPayload.data as Record<string, unknown>).__sreDeferred as Promise<void> | undefined;
      if (sreDeferred) {
        await sreDeferred;
      }
    } catch (handlerError) {
      auditLogger.failure(handlerError instanceof Error ? handlerError.message : 'Handler error');
      throw handlerError;
    }
  } catch (error) {
    Logger.error('[Slack Interactive] Error handling request:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  // Note: We intentionally do NOT close MongoDB connections here
  // Lambda will reuse connections across invocations for better performance
};

export const config = {
  api: {
    externalResolver: true,
    bodyParser: false, // Disable auto body parsing to get raw body for signature verification
  },
};

export default handler;
