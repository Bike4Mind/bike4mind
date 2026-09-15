import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { verifySlackRequest } from '@server/integrations/slack/slackWebhookVerification';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { User, Session, connectDB } from '@bike4mind/database';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { createSession } from '@server/managers/sessionManager';
import { Logger } from '@bike4mind/observability';
import { NextApiRequest, NextApiResponse } from 'next';
import { Config } from '@server/utils/config';
import { decryptToken } from '@server/security/tokenEncryption';
import {
  SlackAuditLogger,
  getClientIp,
  handleB4mCommand,
  SlackClient,
  handleChannelCommand,
  handleSearchCommand,
  buildImageModelPicker,
  getImageModelDisplayName,
  parseImageModelOverride,
  getSlackDeps,
  getSlackDb,
  getOrCreateNotebookForSlackUser,
} from '@bike4mind/slack';
import { Quest } from '@bike4mind/database/content';
import { triggerImageGeneration } from '@bike4mind/slack';

// Slack slash command schema
const SlackCommandSchema = z.object({
  token: z.string(),
  team_id: z.string(),
  team_domain: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  user_id: z.string(),
  user_name: z.string(),
  command: z.string(),
  text: z.string(),
  response_url: z.string(),
  trigger_id: z.string(),
});

async function findUserBySlackId(slackUserId: string) {
  const user = await User.findOne({
    'slackSettings.slackUserId': slackUserId,
  });
  return user;
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  return Promise.race([promise.finally(() => clearTimeout(timeoutId)), timeoutPromise]);
};

// Includes the user token; used by the reminders API.
async function findUserBySlackIdWithToken(slackUserId: string) {
  const user = await User.findOne({
    'slackSettings.slackUserId': slackUserId,
  }).select('+slackSettings.slackUserToken');

  // Debug: log what we found to verify stored slackUserId matches
  if (user) {
    Logger.info('🔐 [findUserBySlackIdWithToken] Found user', {
      querySlackUserId: slackUserId,
      storedSlackUserId: user.slackSettings?.slackUserId,
      hasToken: !!user.slackSettings?.slackUserToken,
      tokenPrefix: user.slackSettings?.slackUserToken?.substring(0, 15) + '...',
      storedScopes: user.slackSettings?.slackUserScopes,
      b4mUserId: user._id?.toString(),
    });
  }

  return user;
}

async function updateUserSlackSettings(userId: string, slackSettings: any) {
  await User.findByIdAndUpdate(userId, { $set: { slackSettings } }, { new: true, upsert: false });
}

async function getUserNotebooks(userId: string, limit = 10) {
  const notebooks = await Session.find({ userId })
    .sort({ lastUpdated: -1 })
    .limit(limit)
    .select('_id name lastUpdated createdAt');

  return notebooks;
}

// Command handlers
async function handleNotebookCommand(dbUser: any, slackUserId: string, commandText: string): Promise<any> {
  const args = commandText.trim().split(' ');
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case '':
    case 'help':
      return getHelpResponse();

    case 'status':
      return await getStatusResponse(dbUser);

    case 'list':
      return await getNotebookListResponse(dbUser.id);

    case 'create':
      return await createNotebookResponse(dbUser, slackUserId, args.slice(1).join(' '));

    case 'set':
      return await setDefaultNotebookResponse(dbUser, slackUserId, args[1]);

    case 'auto':
      return await toggleAutoCreateResponse(dbUser, slackUserId, args[1]);

    case 'config':
      return getConfigModalResponse();

    default:
      return {
        text: `❓ Unknown subcommand: "${subcommand}". Use \`/notebook help\` for available commands.`,
        response_type: 'ephemeral',
      };
  }
}

function getHelpResponse() {
  return {
    text: '📓 Notebook Management Commands',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📓 Notebook Management Commands*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '• `/notebook status` - Show current notebook settings',
            '• `/notebook list` - List your recent notebooks',
            '• `/notebook create [name]` - Create a new notebook',
            '• `/notebook set <id>` - Set default notebook by ID',
            '• `/notebook auto on|off` - Toggle auto-creation',
            '• `/notebook config` - Open settings modal',
            '',
            '*💬 Sending Messages:*',
            'Just mention the bot or send a DM to automatically send messages to your configured notebook!',
          ].join('\n'),
        },
      },
    ],
    response_type: 'ephemeral',
  };
}

async function getStatusResponse(dbUser: any) {
  const slackSettings = dbUser.slackSettings || {};
  const defaultNotebookId = slackSettings.defaultNotebookId;

  let notebookInfo = 'None (auto-create mode)';
  if (defaultNotebookId) {
    try {
      const notebook = await Session.findById(defaultNotebookId).select('name createdAt');

      if (notebook) {
        notebookInfo = `"${notebook.name}" (\`${defaultNotebookId}\`)`;
      } else {
        notebookInfo = `\`${defaultNotebookId}\` ⚠️ (not found)`;
      }
    } catch (error) {
      Logger.error('[Slack Command] Error loading notebook', error);
      notebookInfo = `\`${defaultNotebookId}\` ⚠️ (error loading)`;
    }
  }
  return {
    text: '📊 Current Notebook Settings',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📊 Current Notebook Settings*',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*📓 Default Notebook:*\n${notebookInfo}`,
          },
          {
            type: 'mrkdwn',
            text: `*🤖 Auto-create:*\n${slackSettings.autoCreateNotebook !== false ? 'Enabled' : 'Disabled'}`,
          },
          {
            type: 'mrkdwn',
            text: `*🏷️ Name Prefix:*\n"${slackSettings.notebookNamePrefix || 'Slack Chat'}"`,
          },
          {
            type: 'mrkdwn',
            text: `*👤 Slack User:*\n\`${slackSettings.slackUserId || 'Not linked'}\``,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '📝 Create New',
            },
            action_id: 'create_notebook',
            style: 'primary',
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: '🔧 Configure',
            },
            action_id: 'open_config_modal',
          },
        ],
      },
    ],
    response_type: 'ephemeral',
  };
}

async function getNotebookListResponse(userId: string) {
  try {
    const notebooks = await getUserNotebooks(userId, 10);

    if (notebooks.length === 0) {
      return {
        text: '📚 No notebooks found. Create one with `/notebook create`!',
        response_type: 'ephemeral',
      };
    }

    const notebookFields = notebooks.map(notebook => ({
      type: 'mrkdwn',
      text: `*${notebook.name}*\n\`${notebook._id}\`\n_Updated: ${notebook.lastUpdated.toLocaleDateString()}_`,
    }));

    return {
      text: '📚 Your Recent Notebooks',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*📚 Your Recent Notebooks*',
          },
        },
        {
          type: 'section',
          fields: notebookFields.slice(0, 10), // Slack limits fields
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Showing ${Math.min(notebooks.length, 10)} most recent notebooks. Use \`/notebook set <id>\` to set as default.`,
            },
          ],
        },
      ],
      response_type: 'ephemeral',
    };
  } catch (error) {
    Logger.error('Error listing notebooks:', error);
    return {
      text: '❌ Failed to list notebooks',
      response_type: 'ephemeral',
    };
  }
}

async function createNotebookResponse(dbUser: any, slackUserId: string, customName?: string) {
  try {
    const notebookName =
      customName ||
      `Slack Chat - ${new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`;

    const ability = { can: () => true };
    const newSession = await createSession(dbUser.id, { name: notebookName }, ability as any);

    // Update user's slack settings
    const slackSettings = dbUser.slackSettings || {};
    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      defaultNotebookId: newSession.id,
    });

    return {
      text: `✅ Created notebook: "${newSession.name}"`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Created new notebook:* "${newSession.name}"\n📝 *ID:* \`${newSession.id}\`\n\nThis notebook is now set as your default for Slack messages.`,
          },
        },
      ],
      response_type: 'ephemeral',
    };
  } catch (error: any) {
    // DocumentDB doesn't support sparse unique indexes properly - it enforces uniqueness on
    // null slackMetadata, so a user can have only one notebook without it.
    if (error.code === 11000 && error.message?.includes('slackMetadata')) {
      Logger.warn('[Slack Command] DocumentDB sparse index limitation - user already has manual notebook', {
        userId: dbUser.id,
        errorCode: error.code,
      });

      return {
        text: '⚠️ You already have a notebook. Use `/notebook list` to switch, or create more in the web app.',
        response_type: 'ephemeral',
      };
    }

    Logger.error('Error creating notebook:', error);
    return {
      text: '❌ Failed to create notebook',
      response_type: 'ephemeral',
    };
  }
}

async function setDefaultNotebookResponse(dbUser: any, slackUserId: string, notebookId?: string) {
  if (!notebookId) {
    return {
      text: '❌ Please provide a notebook ID. Usage: `/notebook set <notebook-id>`',
      response_type: 'ephemeral',
    };
  }

  try {
    // Verify the notebook exists and belongs to the user
    const notebook = await Session.findOne({ _id: notebookId, userId: dbUser.id });
    if (!notebook) {
      return {
        text: `❌ Notebook \`${notebookId}\` not found or doesn't belong to you.`,
        response_type: 'ephemeral',
      };
    }

    const slackSettings = dbUser.slackSettings || {};
    await updateUserSlackSettings(dbUser.id, {
      ...slackSettings,
      slackUserId,
      defaultNotebookId: notebookId,
    });

    return {
      text: `✅ Default notebook set to: "${notebook.name}" (\`${notebookId}\`)`,
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

async function toggleAutoCreateResponse(dbUser: any, slackUserId: string, setting?: string) {
  const validSettings = ['on', 'off', 'true', 'false', 'enable', 'disable'];

  if (setting && !validSettings.includes(setting.toLowerCase())) {
    return {
      text: '❌ Invalid setting. Use: `/notebook auto on` or `/notebook auto off`',
      response_type: 'ephemeral',
    };
  }

  try {
    const slackSettings = dbUser.slackSettings || {};
    const currentAutoCreate = slackSettings.autoCreateNotebook !== false;

    let newAutoCreate: boolean;
    if (setting) {
      newAutoCreate = ['on', 'true', 'enable'].includes(setting.toLowerCase());
    } else {
      newAutoCreate = !currentAutoCreate; // Toggle
    }

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
      text: '❌ Failed to update auto-create setting',
      response_type: 'ephemeral',
    };
  }
}

function getConfigModalResponse() {
  return {
    text: 'Opening configuration modal...',
    response_type: 'ephemeral',
    // Stub: a real implementation would trigger a modal via the Slack Web API.
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🔧 *Quick Configuration:*\n\nUse these commands to configure your notebook settings:\n\n• `/notebook auto on` - Enable auto-creation\n• `/notebook set <id>` - Set default notebook\n• `/notebook create <name>` - Create new notebook',
        },
      },
    ],
  };
}

/**
 * Handle the /paint slash command for image generation.
 *
 * Flow:
 * 1. Empty prompt -> help message
 * 2. Inline model override (e.g., "a cat with flux-pro") -> skip picker, generate directly
 * 3. No model override -> show model picker UI
 */
async function handlePaintCommand(
  dbUser: { id: string; organizationId?: string | null },
  slackUserId: string,
  text: string,
  channelId: string,
  slackClient: SlackClient,
  workspace: { id: string; slackBotToken?: string | null }
): Promise<{ response?: Record<string, unknown>; skipResponseUrl: boolean }> {
  const prompt = text.trim();

  // Empty prompt -> help message
  if (!prompt) {
    return {
      response: {
        text: '🎨 *Image Generation*\n\nUsage:\n• `/paint a sunset over mountains` — Choose a model\n• `/paint a cat with flux-pro` — Generate directly with Flux Pro\n\nSupported models: GPT-Image, Flux Pro, Flux Ultra',
        response_type: 'ephemeral',
      },
      skipResponseUrl: false,
    };
  }

  // Get or create notebook for this user
  const notebookId = await getOrCreateNotebookForSlackUser(
    dbUser.id,
    slackUserId,
    prompt,
    channelId,
    undefined,
    null,
    workspace.id
  );

  // Create a quest so the prompt is stored
  const { defineAbilitiesFor } = getSlackDb();
  const { sessionManager } = getSlackDeps();
  // unknown: defineAbilitiesFor DI model doesn't preserve exact return types
  const ability = (defineAbilitiesFor as unknown as (user: unknown) => unknown)(dbUser);
  const createdQuest = await sessionManager.addMessageToSession(
    dbUser.id,
    notebookId,
    { timestamp: new Date(), type: 'message', prompt },
    ability
  );
  if (!createdQuest.id) {
    Logger.error('🎨 [/paint] Quest created without ID', { userId: dbUser.id });
    return {
      response: { text: '❌ Failed to create image generation request.', response_type: 'ephemeral' },
      skipResponseUrl: false,
    };
  }
  const questId = createdQuest.id;

  // Check for inline model override (e.g., "a cat with flux-pro")
  const modelOverride = parseImageModelOverride(prompt);

  if (modelOverride) {
    // Direct generation - skip picker
    const modelDisplayName = getImageModelDisplayName(modelOverride);

    // Post public "Generating..." message to channel
    const statusTs = await slackClient.sendMessage({
      channel: channelId,
      text: `🎨 Generating with ${modelDisplayName}... This may take a minute or two.`,
    });

    if (statusTs) {
      await triggerImageGeneration({
        notebookId,
        userId: dbUser.id,
        prompt,
        model: modelOverride,
        questId,
        slackNotification: {
          workspaceId: workspace.id,
          channelId,
          threadTs: statusTs,
          messageTs: statusTs,
        },
      });
    }

    return { skipResponseUrl: true };
  }

  // No model override -> show model picker
  // Store pending image generation as a pendingAction on the quest
  await Quest.findByIdAndUpdate(questId, {
    pendingAction: { tool: 'image_generation', params: { prompt, userId: dbUser.id }, ts: Date.now() },
  });

  // Post public model picker UI to channel
  const pickerBlocks = buildImageModelPicker(questId, prompt);
  await slackClient.sendMessage({
    channel: channelId,
    text: '🎨 Choose an image model:',
    blocks: pickerBlocks,
  });

  Logger.info('🎨 [/paint] Model picker sent', { questId });

  return { skipResponseUrl: true };
}

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Connect to database
  try {
    const mongoUri = Config.MONGODB_URI.replace('%STAGE%', Config.STAGE);
    await connectDB(mongoUri);
  } catch (error) {
    Logger.error('[Slack Command] Failed to connect to MongoDB', error);
    return res.status(500).json({ error: 'Database connection failed' });
  }

  // Get signing secret from first active workspace
  const workspaces = await slackDevWorkspaceRepository.findAllActive();
  if (workspaces.length === 0) {
    Logger.error('[Slack Command] No Slack workspaces configured');
    return res.status(500).json({
      error: 'Slack workspace not configured. Please create a Slack app via the admin panel.',
    });
  }

  const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaces[0].id);
  if (!workspace) {
    Logger.error('[Slack Command] Failed to load workspace configuration');
    return res.status(500).json({
      error: 'Failed to load Slack workspace configuration.',
    });
  }

  const signingSecret = workspace.slackOAuthSigningSecret;
  if (!signingSecret) {
    Logger.error('[Slack Command] Signing secret not configured for workspace');
    return res.status(500).json({
      error: 'Slack signing secret not configured for workspace.',
    });
  }

  // Verify Slack request: timestamp freshness + HMAC signature
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const body = new URLSearchParams(req.body as Record<string, string>).toString();

  // Create integration audit logger for webhook verification tracking
  const integrationAuditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'webhook',
      integrationName: 'slack',
      action: 'webhook_command',
      requestId: randomUUID().split('-')[0],
    },
    req
  );

  const verifyResult = verifySlackRequest(body, timestamp, signature, signingSecret);
  if (!verifyResult.valid) {
    Logger.warn('[Slack Command] Request verification failed', {
      reason: verifyResult.reason,
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
    });
    integrationAuditLogger.failure(verifyResult.reason);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  integrationAuditLogger.success();

  try {
    const commandData = SlackCommandSchema.safeParse(req.body);
    if (!commandData.success) {
      Logger.error('[Slack Command] Invalid command data:', commandData.error);
      return res.status(400).json({ error: 'Invalid command data' });
    }

    const { user_id, text, command, team_id, channel_id, trigger_id } = commandData.data;
    const botToken = decryptToken(workspace.slackBotToken);

    // Create audit logger for this command
    const auditLogger = SlackAuditLogger.create({
      eventType: 'command',
      slackUserId: user_id,
      slackTeamId: team_id,
      action: `execute_command:${command}`,
      metadata: { command, subcommand: text.split(' ')[0] || 'help' },
      ipAddress: getClientIp(req),
    });
    // FAST PATH: Open /b4m schedule modal IMMEDIATELY before trigger_id expires (3s limit)
    // This must happen BEFORE res.status(200) and BEFORE any async user lookups
    if (command === '/b4m' && botToken) {
      const scheduleArgs = text.trim().split(/\s+/);
      const isModalCommand = scheduleArgs[0]?.toLowerCase() === 'schedule' && scheduleArgs.length === 1;

      if (isModalCommand) {
        try {
          const { WebClient } = await import('@slack/web-api');
          const { buildScheduleMessageModal } = await import('@bike4mind/slack');

          const client = new WebClient(botToken);
          const logger = new Logger({ metadata: { component: 'ScheduleCommand' } });

          const modal = buildScheduleMessageModal({
            userTimezone: 'User Timezone',
            channelId: channel_id,
          });

          const viewResponse = await client.views.open({
            trigger_id,
            view: modal,
          });

          // Update timezone in background - await to ensure it completes before Lambda terminates
          if (viewResponse.ok && viewResponse.view?.id) {
            const viewId = viewResponse.view.id;
            const { SlackClient } = await import('@bike4mind/slack');
            const slackClient = new SlackClient(botToken, logger);

            try {
              const userTimezone = await slackClient.getUserTimezone(user_id);
              const updatedModal = buildScheduleMessageModal({ userTimezone, channelId: channel_id });
              await client.views.update({ view_id: viewId, view: updatedModal });
            } catch (tzError) {
              logger.warn('[Slack Command] Failed to update timezone:', tzError);
            }
          }

          // Modal opened successfully - return immediately
          return res.status(200).send('');
        } catch (error) {
          Logger.error('[Slack Command] Fast-path modal failed:', error);
          // Fall through to normal flow
        }
      }
    }

    // Send empty acknowledgment to meet Slack's 3-second timeout
    // Users will only see the actual response sent via response_url
    res.status(200).send('');

    // IIFE + await: without awaiting, Lambda kills this async work once the HTTP response
    // returns; with it, Lambda waits (~10s) so the result still reaches response_url.
    await (async () => {
      const response_url = commandData.data.response_url;
      try {
        const dbUser = await findUserBySlackId(user_id);

        if (!dbUser) {
          auditLogger.failure('User not found');
          await fetch(response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: '❌ User not found. Please link your Slack account in your profile settings.',
              response_type: 'ephemeral',
            }),
          });
          return;
        }

        // Update audit context with B4M user ID
        auditLogger.setUserId(dbUser.id);

        // Handle different commands
        let response;
        let skipResponseUrl = false;

        if (!workspace.slackBotToken) {
          Logger.error('[Slack Command] Bot token not configured');
          response = {
            text: '❌ Slack bot token is not configured for this workspace.',
            response_type: 'ephemeral',
          };
        } else {
          const slackClient = new SlackClient(botToken ?? '', new Logger({ metadata: { component: 'SlackCommands' } }));

          switch (command) {
            case '/notebook':
              response = await handleNotebookCommand(dbUser, user_id, text);
              break;

            case '/b4m': {
              if (!botToken) {
                response = {
                  text: '❌ Bot token not configured. Please contact your administrator.',
                  response_type: 'ephemeral',
                };
                break;
              }

              // Parse command arguments
              const args = text.trim().split(/\s+/);
              const subcommand = args[0]?.toLowerCase();

              // Handle search command: /b4m search <query>
              if (subcommand === 'search') {
                const query = args.slice(1).join(' ');
                try {
                  // For search we need the user token
                  const userWithToken = await findUserBySlackIdWithToken(user_id);
                  const userToken = decryptToken(userWithToken?.slackSettings?.slackUserToken) ?? undefined;

                  response = await withTimeout(
                    handleSearchCommand(dbUser, user_id, query, userToken),
                    10000, // 10s timeout for search
                    'Search timed out'
                  );
                } catch (error) {
                  Logger.error('[Slack Command] Search command timed out', { query });
                  response = {
                    text: '⏱️ The search took too long. Please try again with a more specific query.',
                    response_type: 'ephemeral',
                  };
                }
                break;
              }

              // For other /b4m commands (like schedule), we need the user token for reminders
              // Re-fetch user with token since findUserBySlackId excludes it
              const userWithToken = await findUserBySlackIdWithToken(user_id);
              const userToken = decryptToken(userWithToken?.slackSettings?.slackUserToken) ?? undefined;
              const userScopes = userWithToken?.slackSettings?.slackUserScopes;

              Logger.info('🔧 [/b4m Command] User token lookup', {
                slackUserId: user_id,
                commandTeamId: team_id, // Team where command was sent from
                hasUserWithToken: !!userWithToken,
                hasSlackSettings: !!userWithToken?.slackSettings,
                hasUserToken: !!userToken,
                userTokenPrefix: userToken ? userToken.substring(0, 10) + '...' : 'none',
                userScopes: userScopes || [],
                commandText: text.substring(0, 50),
              });

              const b4mResult = await handleB4mCommand(text, {
                dbUser,
                slackUserId: user_id,
                channelId: channel_id,
                triggerId: trigger_id,
                botToken,
                userToken,
                userScopes,
              });

              if (b4mResult.openModal) {
                // Modal was opened, no response needed
                skipResponseUrl = true;
              } else {
                response = b4mResult.response;
              }
              break;
            }

            case '/channel':
              try {
                response = await withTimeout(
                  handleChannelCommand(dbUser, user_id, text, slackClient),
                  5000,
                  'Command timed out'
                );
              } catch (error) {
                Logger.error('[Slack Command] Channel command timed out', { command: text });
                response = {
                  text: '⏱️ The command took too long to process. Please try again.',
                  response_type: 'ephemeral',
                };
              }
              break;

            case '/paint': {
              const result = await handlePaintCommand(dbUser, user_id, text, channel_id, slackClient, workspace);
              if (result.skipResponseUrl) skipResponseUrl = true;
              else response = result.response;
              break;
            }

            default:
              response = {
                text: `❓ Unknown command: ${command}`,
                response_type: 'ephemeral',
              };
          }
        }

        // Send actual response via response_url (skip if modal was opened)
        // This is the only message users will see (empty ack above is invisible)
        if (!skipResponseUrl && response) {
          const fetchResponse = await fetch(response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
          });

          if (!fetchResponse.ok) {
            Logger.error('[Slack Command] Failed to send response', {
              status: fetchResponse.status,
              statusText: fetchResponse.statusText,
            });
            auditLogger.failure('Failed to send response');
          } else {
            auditLogger.success();
          }
        }
      } catch (error) {
        Logger.error('[Slack Command] Error processing command:', error);
        auditLogger.failure(error instanceof Error ? error.message : 'Unknown error');
        try {
          await fetch(response_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: '❌ Internal server error. Please try again.',
              response_type: 'ephemeral',
            }),
          });
        } catch (fetchError) {
          Logger.error('[Slack Command] Failed to send error response:', fetchError);
        }
      }
    })();

    return;
  } catch (error) {
    Logger.error('[Slack Command] Error handling request:', error);
    return res.status(500).json({
      text: '❌ Internal server error. Please try again.',
      response_type: 'ephemeral',
    });
  }
  // Note: We intentionally do NOT close MongoDB connections here
  // Lambda will reuse connections across invocations for better performance
};

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
