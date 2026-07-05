import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { z } from 'zod';
import { randomUUID } from 'crypto';
import { verifySlackRequest } from '@server/integrations/slack/slackWebhookVerification';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { User } from '@bike4mind/database/auth';
import { Organization } from '@bike4mind/database/infra';
import { Quest } from '@bike4mind/database/content';
import { McpServer } from '@bike4mind/database/ai';
import { isPlaceholderValue, ISlackDevWorkspaceDocument, McpServerName, SlackEvents } from '@bike4mind/common';
import { InternalServerError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import {
  AGENT_REGISTRY,
  buildSystemPrompt,
  handleUnlinkedUser,
  createMockUser,
  determineThreadStrategy,
  getOrCreateNotebookForSlackUser,
  formatAgentResponse,
  sendMessageToNotebookAndGetResponse,
  SlackClient,
  SlackMessage,
  SlackEvent,
  type SlackEventData,
  CommandHandler,
  createLoadingBar,
  buildConfirmationButtons,
  buildAttachmentDownloadButtons,
  formatPreviewFromParams,
  AttachmentDownloadInfo,
  AppHomeBuilder,
  buildErrorHomeView,
  ChannelConfigSummary,
  AppHomeDataService,
  AppHomeNotebook,
  categorizeError,
  withRetry,
  SlackAuditLogger,
  getClientIp,
  WorkflowStepHandler,
  FunctionExecutedEvent,
  TOKEN_EXPIRATION_MS,
  buildImageModelPicker,
} from '@bike4mind/slack';
import { logEvent } from '@server/utils/analyticsLog';
import { slackChannelConfigRepository } from '@bike4mind/database';
import { decryptToken } from '@server/security/tokenEncryption';
import { getGeneratedImageStorage } from '@server/utils/storage';

// Slack event schemas
const SlackEventSchema = z.object({
  token: z.string(),
  team_id: z.string(),
  api_app_id: z.string(),
  event: z.object({
    type: z.string(),
    subtype: z.string().optional(), // Message subtype (channel_join, channel_leave, bot_message, etc.)
    channel: z.string().optional(),
    user: z.string().optional(), // Optional: bot messages don't have user
    text: z.string().optional(), // Optional: some events don't have text
    ts: z.string().optional(), // Optional: app_home_opened events don't have ts
    thread_ts: z.string().optional(), // Thread timestamp if this is a reply
    tab: z.string().optional(), // For app_home_opened events: "home" or "messages"
    app_mention: z.boolean().optional(),
    bot_id: z.string().optional(), // Bot messages have bot_id instead of user
    workflow_step: z
      .object({
        workflow_step_execute_id: z.string(),
        workflow_id: z.string(),
        workflow_instance_id: z.string(),
        step_id: z.string(),
        inputs: z.record(z.string(), z.any()).optional(),
      })
      .optional(), // For workflow_step_execute events (legacy)
    // New Workflow Steps API (function_executed event)
    function: z
      .object({
        id: z.string(),
        callback_id: z.string(),
        title: z.string(),
        description: z.string().optional(),
        type: z.string(),
        app_id: z.string(),
      })
      .optional(),
    inputs: z.record(z.string(), z.any()).optional(), // Function inputs
    function_execution_id: z.string().optional(),
    workflow_execution_id: z.string().optional(),
    bot_access_token: z.string().optional(),
    event_ts: z.string().optional(), // Event timestamp for function_executed events
    files: z
      .array(
        z.object({
          id: z.string(),
          // Normally present but Slack may omit them for edge-case events
          // (e.g. pending/deleted files). Optional so the event is not rejected;
          // processSlackFiles guards against missing fields before use.
          name: z.string().optional(),
          mimetype: z.string().optional(),
          url_private: z.string().optional(),
          url_private_download: z.string().optional(),
          filetype: z.string().optional(),
          size: z.number().optional(),
          title: z.string().optional(),
        })
      )
      .optional(), // File attachments (optional)
  }),
  type: z.string(),
  event_id: z.string(),
  event_time: z.number(),
});

const SlackUrlVerificationSchema = z.object({
  token: z.string(),
  challenge: z.string(),
  type: z.literal('url_verification'),
});

// Build regex pattern from available agent types in AGENT_REGISTRY
const AGENT_COMMAND_PATTERN = new RegExp(`^@(${Object.keys(AGENT_REGISTRY).join('|')})\\b`, 'i');

// Helper function to get raw body from request
async function getRawBody(req: Request): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// User lookup functions moved to ./handlers/user-lookup.ts
// Notebook management functions moved to ./handlers/notebook-manager.ts
// Slack API functions moved to SlackClient.ts (fetchChannelHistory, getUserName, fetchThreadHistory, sendMessage, updateMessage)

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const requestStartTime = Date.now();
  const logger = req.logger;
  // NOTE: Uncomment to show all debug level logs
  // logger.setLevel('debug');

  // Get raw body for signature verification
  const rawBody = await getRawBody(req);
  const body = JSON.parse(rawBody);

  // Handle URL verification for Slack app setup FIRST (before any authentication checks)
  // URL verification doesn't include signatures, so it must be checked before signature validation
  const urlVerification = SlackUrlVerificationSchema.safeParse(body);
  if (urlVerification.success) {
    logger.info('Slack URL verification successful');
    return res.json({ challenge: urlVerification.data.challenge });
  }

  // Detect which bot this request is for by checking api_app_id
  const apiAppId = body.api_app_id;
  const teamId = body.team_id;

  // Create integration audit logger for webhook verification tracking
  const integrationAuditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'webhook',
      integrationName: 'slack',
      action: 'webhook_event',
      requestId: randomUUID().split('-')[0],
      metadata: { teamId, apiAppId },
    },
    req
  );

  let signingSecret: string | undefined;
  let slackBotToken: string | undefined;
  let botType: string;
  let workspace: ISlackDevWorkspaceDocument | null = null;
  let workspaceWithCreds: ISlackDevWorkspaceDocument | null = null;
  let orgWorkspaceId: string | undefined;
  let orgWorkspaceName: string | undefined;

  // Fetch Slack App credentials
  if (apiAppId && teamId) {
    workspace = await slackDevWorkspaceRepository.findBySlackAppIdAndTeamId(apiAppId, teamId);
    if (workspace) {
      workspaceWithCreds = await slackDevWorkspaceRepository.findByIdWithCredentials(workspace.id);
      if (!workspaceWithCreds) {
        throw new Error('Failed to load workspace credentials');
      }

      signingSecret = workspaceWithCreds.slackOAuthSigningSecret;
      slackBotToken = decryptToken(workspaceWithCreds.slackBotToken) ?? '';
      botType = 'dev-oauth';
      logger.debug('✅ [MULTI-WORKSPACE] Using OAuth workspace token', {
        workspaceName: workspaceWithCreds.name,
        teamId: workspaceWithCreds.slackTeamId,
        botName: workspaceWithCreds.slackBotName,
      });
    } else {
      // Fallback: check org-level Slack workspaces
      const orgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
      if (orgWorkspace) {
        if (!orgWorkspace.slackBotToken) {
          logger.error('[ORG-WORKSPACE] Org workspace found but bot token is missing', {
            teamId: orgWorkspace.slackTeamId,
            organizationId: orgWorkspace.organizationId,
          });
          throw new InternalServerError('Org workspace bot token not configured');
        }

        // Get signing secret from the system app (shared across all installs)
        const appWorkspace = await slackDevWorkspaceRepository.findBySlackAppId(apiAppId);
        if (!appWorkspace) {
          throw new Error('System Slack app not found for signing secret');
        }

        signingSecret = appWorkspace.slackOAuthSigningSecret;
        slackBotToken = decryptToken(orgWorkspace.slackBotToken) ?? '';
        botType = 'org-oauth';
        orgWorkspaceId = orgWorkspace.id;
        orgWorkspaceName = orgWorkspace.slackTeamName || orgWorkspace.slackTeamId;
        logger.debug('✅ [ORG-WORKSPACE] Using org workspace token', {
          teamId: orgWorkspace.slackTeamId,
          organizationId: orgWorkspace.organizationId,
        });
      } else {
        throw new NotFoundError(`Workspace not found for app ${apiAppId} and team ${teamId}`);
      }
    }
  } else {
    throw new NotFoundError(`Missing app_id or team_id: appId=${apiAppId}, teamId=${teamId}`);
  }

  logger.debug('🤖 Slack bot detected:', {
    botType,
    apiAppId,
    teamId,
    workspaceName: workspace?.name || orgWorkspaceName || 'legacy',
    signingSecretExists: !!signingSecret,
    botTokenExists: !!slackBotToken,
    botTokenPrefix: slackBotToken ? slackBotToken.substring(0, 12) + '...' : 'missing',
  });

  if (!signingSecret || isPlaceholderValue(signingSecret)) {
    logger.error(`Slack signing secret not configured for ${botType} bot`, { apiAppId });
    throw new InternalServerError('Slack signing secret not configured');
  }

  // Verify Slack request: timestamp freshness + HMAC signature
  const signature = req.headers['x-slack-signature'] as string | undefined;
  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;

  const verifyResult = verifySlackRequest(rawBody, timestamp, signature, signingSecret);
  if (!verifyResult.valid) {
    logger.warn('[Slack Events] Request verification failed', {
      reason: verifyResult.reason,
      botType,
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
    });
    integrationAuditLogger.failure(verifyResult.reason);
    throw new UnauthorizedError('Unauthorized');
  }

  integrationAuditLogger.success();

  // Slack retries events when it doesn't get HTTP 200 within 3 seconds.
  // These retries can bypass MongoDB dedup TTL (5 min) and cause duplicate responses.
  // Trade-off: dropping all retries means genuinely failed first attempts (cold start,
  // transient DB error) won't be retried. We accept this because duplicate responses are
  // a worse UX than a missed message (which the user can re-send).
  // Check AFTER signature verification so unauthenticated requests cannot trigger this path.
  const retryNum = req.headers['x-slack-retry-num'];
  if (retryNum) {
    logger.warn('[Slack] Retry dropped — returning 200 immediately', {
      retryNum,
      retryReason: req.headers['x-slack-retry-reason'],
    });
    return res.status(200).json({ ok: true, retry_acknowledged: true });
  }

  // Handle Slack events
  const eventData = SlackEventSchema.safeParse(body);
  if (!eventData.success) {
    // Return 200 so Slack does not retry. The event schema validation failing is
    // non-fatal - retrying would produce the same error and flood the logs.
    logger.warn('[Slack Events] Event validation failed — returning 200 to suppress Slack retries', {
      error: eventData.error.issues,
    });
    return res.status(200).json({ ok: true });
  }

  const { event, event_id } = eventData.data;

  // Wrap event data in SlackEvent class for type-safe operations
  const slackEvent = new SlackEvent(event as SlackEventData, workspace || undefined);

  logger.debug('📨 [SLACK EVENT] Received event', {
    event: JSON.stringify(event, null, 2),
    processId: process.pid,
  });

  // Handle App Home opened event (different structure from message events)
  if (slackEvent.type === 'app_home_opened') {
    const slackClient = new SlackClient(slackBotToken!, logger);
    const slackUserId = slackEvent.user;

    if (!slackUserId) {
      logger.warn('[App Home] No user ID in app_home_opened event');
      return res.status(200).json({ message: 'App Home event missing user ID' });
    }

    // Create audit logger for App Home event
    const auditLogger = SlackAuditLogger.create({
      eventType: 'event',
      slackUserId,
      slackTeamId: teamId,
      action: 'app_home_opened',
      resourceType: 'none',
      ipAddress: getClientIp(req),
    });

    try {
      // Get basic user info and app name
      const appName = workspaceWithCreds?.slackBotName || workspace?.name || orgWorkspaceName;
      const slackUserInfo = await slackClient.getUserInfo(slackUserId);
      const displayName = slackUserInfo?.real_name || slackUserInfo?.name;

      // Note: We don't publish a loading view because Slack shows the cached
      // previous view while we fetch data. Publishing loading would cause
      // a flicker: cached content -> loading -> new content. Better UX is to
      // let Slack show cached view, then update directly to new content.

      // Look up B4M user by Slack ID
      const b4mUser = await User.findOne({ 'slackSettings.slackUserId': slackUserId });

      // Update audit context with B4M user ID if found
      if (b4mUser) {
        auditLogger.setUserId(b4mUser.id);
      }

      // Check integration status if user exists
      let hasGitHubConnected = false;
      let hasJiraConnected = false;

      if (b4mUser) {
        // Check GitHub: look for enabled MCP server
        const githubMcpServer = await McpServer.findOne({
          userId: b4mUser.id,
          name: McpServerName.Github,
          enabled: true,
        });
        hasGitHubConnected = !!githubMcpServer;

        // Check Jira: look for Atlassian OAuth connection
        hasJiraConnected =
          !!b4mUser.atlassianConnect?.accessToken && b4mUser.atlassianConnect?.status !== 'needs_reconnect';
      }

      // Fetch personalized content if user is linked
      let notebooks: AppHomeNotebook[] = [];
      let stats = { totalNotebooks: 0, messagesThisWeek: 0, activeProjects: 0 };
      let isAdmin = false;
      let orgDefaults: { preferredModel?: string; temperature?: number; maxTokens?: number } | undefined;
      let channelConfigs: ChannelConfigSummary[] = [];

      if (b4mUser) {
        const dataService = new AppHomeDataService(logger);
        const appHomeData = await dataService.fetchAppHomeData(b4mUser.id);
        notebooks = appHomeData.notebooks;
        stats = appHomeData.stats;

        // Check Slack workspace admin/owner status and load admin data
        isAdmin = slackUserInfo?.is_admin === true || slackUserInfo?.is_owner === true;
        if (isAdmin) {
          // Load channel configs by workspace (no org required)
          const configsPromise = slackChannelConfigRepository.findBySlackTeamId(teamId);
          // Load org defaults only if user has an org
          const orgPromise = b4mUser.organizationId
            ? Organization.findById(b4mUser.organizationId).select('preferredModel temperature maxTokens').lean()
            : Promise.resolve(null);

          const [org, configs] = await Promise.all([orgPromise, configsPromise]);
          // Pass an object (even with empty values) when user has a valid org, so UI can show Edit button
          orgDefaults = org
            ? { preferredModel: org.preferredModel, temperature: org.temperature, maxTokens: org.maxTokens }
            : undefined;
          channelConfigs = configs.map(c => ({
            channelId: c.channelId,
            preferredModel: c.preferredModel,
            temperature: c.temperature,
            maxTokens: c.maxTokens,
          }));
        }
      }

      logger.debug('[App Home] User data fetched', {
        slackUserId,
        b4mUserFound: !!b4mUser,
        notebookCount: notebooks.length,
      });

      // Build personalized home view
      const homeBuilder = new AppHomeBuilder({
        slackUserId,
        displayName,
        hasGitHubConnected,
        hasJiraConnected,
        appName,
        notebooks,
        stats,
        isLinked: !!b4mUser,
        webAppBaseUrl: process.env.APP_URL,
        isAdmin,
        orgDefaults,
        channelConfigs,
      });

      const blocks = homeBuilder.build();
      const success = await slackClient.publishHomeView(slackUserId, blocks);

      if (success) {
        auditLogger.success({ notebookCount: notebooks.length, isLinked: !!b4mUser });
        return res.status(200).json({ message: 'App Home view published' });
      } else {
        auditLogger.failure('Failed to publish home view');
        // Try to publish error view
        await slackClient.publishHomeView(slackUserId, buildErrorHomeView(appName));
        return res.status(200).json({ message: 'App Home view failed, showing error view' });
      }
    } catch (error) {
      logger.error('[App Home] Error publishing home view', { slackUserId, error });
      auditLogger.failure(error instanceof Error ? error.message : 'Unknown error');
      // Try to publish error view
      try {
        const appName = workspaceWithCreds?.slackBotName || workspace?.name || orgWorkspaceName;
        await slackClient.publishHomeView(slackUserId, buildErrorHomeView(appName));
      } catch {
        // Ignore secondary error
      }
      return res.status(200).json({ message: 'App Home error' });
    }
  }

  // Handle Workflow Step Execution
  if (slackEvent.type === 'workflow_step_execute') {
    const slackClient = new SlackClient(slackBotToken!, logger);
    // We know workflow_step exists based on event type, but schema makes it optional
    const workflowStep = (event as any).workflow_step;

    if (!workflowStep) {
      logger.error('Missing workflow_step data for workflow_step_execute event');
      return res.status(200).json({ message: 'Missing workflow data' });
    }

    const { workflow_step_execute_id, inputs } = workflowStep;
    logger.info('Processing workflow step execution', {
      workflowStepExecuteId: workflow_step_execute_id,
      inputs: JSON.stringify(inputs),
    });

    try {
      // Execute workflow logic with retry for transient failures
      await withRetry(
        async () => {
          // Placeholder workflow logic; error triggers below exercise error categorization
          if (inputs && inputs.error_trigger === 'user') {
            throw new Error('not_in_channel'); // Will be categorized as PERMISSION_DENIED
          }
          if (inputs && inputs.error_trigger === 'system') {
            throw new Error('slack_web_api_platform_error'); // Will be categorized as INTERNAL_ERROR
          }

          logger.debug('Workflow step logic executed successfully');
        },
        { maxAttempts: 3 }, // Retry up to 3 times
        logger
      );

      // Report success
      await slackClient.workflowStepCompleted(workflow_step_execute_id, {
        message: 'Workflow step completed successfully',
      });

      return res.status(200).json({ message: 'Workflow step processed successfully' });
    } catch (error) {
      // Categorize and handle error
      const workflowError = categorizeError(error);

      logger.error('Workflow step failed', {
        workflowStepExecuteId: workflow_step_execute_id,
        category: workflowError.category,
        message: workflowError.message,
        userMessage: workflowError.userMessage,
        context: workflowError.context,
      });

      // Report failure to Slack so the workflow stops gracefully
      await slackClient.workflowStepFailed(workflow_step_execute_id, {
        message: workflowError.userMessage,
      });

      return res.status(200).json({ message: 'Workflow step failed reported' });
    }
  }

  // Handle Function Executed (new Workflow Steps API)
  if (event.type === 'function_executed') {
    const slackClient = new SlackClient(slackBotToken!, logger);

    // Validate function_executed event structure (fields defined in Zod schema)
    const functionData = event.function;
    const functionExecutionId = event.function_execution_id;
    const inputs = event.inputs || {};

    if (!functionData || !functionExecutionId) {
      logger.error('Missing function data for function_executed event', {
        hasFunction: !!functionData,
        hasFunctionExecutionId: !!functionExecutionId,
      });
      return res.status(200).json({ message: 'Missing function data' });
    }

    // Build the event object for the handler
    const functionEvent: FunctionExecutedEvent = {
      type: 'function_executed',
      function: functionData,
      inputs,
      function_execution_id: functionExecutionId,
      workflow_execution_id: event.workflow_execution_id || '',
      event_ts: event.event_ts || '',
      bot_access_token: event.bot_access_token,
    };

    // Create handler and process
    const workflowStepHandler = new WorkflowStepHandler(slackClient, logger);

    // Process the function execution and wait for completion
    // Note: function_executed events have longer timeout allowance from Slack
    try {
      await workflowStepHandler.handleFunctionExecuted(functionEvent);
    } catch (error) {
      logger.error('Function execution failed', {
        functionExecutionId,
        totalRequestDurationMs: Date.now() - requestStartTime,
        error: error instanceof Error ? error.message : String(error),
      });
      // Report failure to Slack so the workflow knows execution failed
      try {
        await slackClient.functionCompleteError(functionExecutionId, 'Workflow execution failed unexpectedly');
      } catch (err) {
        logger.error('Failed to report error to Slack', {
          functionExecutionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return res.status(200).json({ message: 'Function execution completed' });
  }

  // Message events require a timestamp - if missing, skip processing
  if (!event.ts) {
    return res.status(200).json({ message: 'Event skipped: no timestamp' });
  }

  // Check if event should be processed (includes filtering AND deduplication)
  const { shouldProcess: shouldProcessEvent, reason } = await slackEvent.shouldProcess(
    event_id,
    AGENT_COMMAND_PATTERN,
    logger
  );

  if (!shouldProcessEvent) {
    logger.info('Event not processed', {
      reason,
      eventType: slackEvent.type,
      isDM: slackEvent.isDM,
      isThreaded: slackEvent.isThreaded,
      isBotMessage: slackEvent.isBotMessage,
      isSystemMessage: slackEvent.isSystemMessage(),
      eventId: event_id,
    });
    return res.status(200).json({ message: `Event not processed: ${reason}` });
  }

  // Keep backward compatibility references for existing code
  logger.debug(`Processing Slack event: ${slackEvent.type}`, {
    eventId: event_id,
    messageTs: slackEvent.ts,
    channel: slackEvent.channel,
    userId: slackEvent.user,
  });

  // Create audit logger for message event
  const messageAuditLogger = SlackAuditLogger.create({
    eventType: 'event',
    slackUserId: slackEvent.user || 'unknown',
    slackTeamId: teamId,
    action: `message_received:${slackEvent.type}`,
    resourceType: 'message',
    metadata: {
      channel: slackEvent.channel,
      isDM: slackEvent.isDM,
      isThreaded: slackEvent.isThreaded,
    },
    ipAddress: getClientIp(req),
  });

  // Create SlackClient early so it's available for enrichment and unlinked user handling
  const slackClient = new SlackClient(slackBotToken!, logger);

  // Enrich message content by fetching full data from Web API
  // This is needed because Slack's Events API truncates table data.
  const enrichmentResult = await slackEvent.enrichMessageContent(slackClient, logger);
  if (enrichmentResult.wasEnriched) {
    logger.debug('📊 [TABLE-DATA] Message enriched with Web API data', {
      tableCount: enrichmentResult.tableCount,
      enrichedTextLength: slackEvent.text.length,
    });
  }

  // Find user by Slack ID using SlackEvent helper
  let user = await slackEvent.getInternalUser();

  // TEMPORARY: If database lookup fails, create a mock user for testing
  if (!user) {
    // Check if we have SLACK_BYPASS_USER_LOOKUP environment variable for testing
    if (process.env.SLACK_BYPASS_USER_LOOKUP === 'true') {
      user = createMockUser(slackEvent.user, event_id, slackEvent.ts, slackEvent.channel) as any;
    } else {
      // Handle unlinked user with onboarding message
      await handleUnlinkedUser(
        slackEvent.channel,
        slackEvent.user,
        event_id,
        slackEvent.ts,
        slackBotToken,
        slackEvent.getReplyThreadTs(), // Use message ts to start a new thread if not already in one
        (ch: string, text: string, _token?: string, threadTs?: string) =>
          slackClient.sendMessage({ channel: ch, text: text, threadTs: threadTs })
      );

      return res.status(200).json({
        message: 'Slack account not linked - instructional message sent',
      });
    }
  }

  // Final safety check (shouldn't be needed but helps TypeScript)
  if (!user) {
    logger.error('Unexpected: user is still null after processing');
    throw new InternalServerError('User processing failed');
  }
  if (!slackBotToken) {
    logger.error('SLACK_BOT_TOKEN not configured - cannot send responses');
    throw new InternalServerError('SLACK_BOT_TOKEN not configured');
  }

  const commandHandler = new CommandHandler(slackEvent, user, slackClient, logger);
  const commandStartTime = Date.now();

  // Log command received analytics event (tracks ALL Slack agent commands)
  logEvent({
    type: SlackEvents.SLACK_COMMAND_RECEIVED as any,
    userId: user.id,
    metadata: {
      channel: slackEvent.channel,
      isThreaded: slackEvent.isThreaded,
      hasFiles: slackEvent.hasFiles,
    },
  }).catch(err =>
    logger.error('Failed to log SLACK_COMMAND_RECEIVED event', {
      error: err instanceof Error ? err.message : typeof err === 'object' ? JSON.stringify(err) : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  );

  // Load custom agent if configured in user's settings
  await commandHandler.loadCustomAgentIfConfigured();

  // Fetch context for thread context and LLM routing
  // (e.g., a follow-up "make this issue in lumina5" in a thread that already mentioned "gh issue")
  let contextMessages: SlackMessage[] = [];
  try {
    const slackContextMessages = await commandHandler.getSlackContextMessages();

    if (slackContextMessages.contextMessages.length > 0) {
      // any: SlackMessage types from thread-intelligence vs SlackClient differ structurally but are compatible
      contextMessages = slackContextMessages.contextMessages as any;
    }
  } catch (contextError) {
    logger.warn('[Slack] Failed to fetch context messages, proceeding without context', {
      error: contextError instanceof Error ? contextError.message : String(contextError),
    });
  }

  // Determine thread_ts for bot reply
  const { replyThreadTs } = determineThreadStrategy({ thread_ts: slackEvent.threadTs, ts: slackEvent.ts });

  const notebookId = await getOrCreateNotebookForSlackUser(
    user!.id,
    slackEvent.user,
    commandHandler.parsedCommand.command,
    slackEvent.channel,
    replyThreadTs, // Use thread-first strategy for notebook lookup
    commandHandler.parsedCommand.agentName, // Pass agent name for per-agent routing
    workspace?.id || orgWorkspaceId // Pass workspace ID for async notification
  );

  // Check for pending action to conditionally enable confirm/cancel tools for the LLM
  const questWithPending = await Quest.findOne({
    sessionId: notebookId,
    pendingAction: { $exists: true },
  }).sort({ createdAt: -1 });

  let pendingActionTools: string[] = [];

  if (questWithPending?.pendingAction) {
    const pa = questWithPending.pendingAction;
    const ageMs = Date.now() - pa.ts;
    const expiresInMs = TOKEN_EXPIRATION_MS - ageMs;

    if (expiresInMs > 0) {
      pendingActionTools = ['confirm_pending_action', 'cancel_pending_action'];

      logger.debug('🔐 [PENDING ACTION] Found pending action, enabling confirm/cancel tools', {
        questId: questWithPending._id,
        tool: pa.tool,
        expiresInMinutes: Math.round(expiresInMs / 60000),
      });
    }
  }

  // Resource prompts and agent command processing now handled by LLM tools

  // Handle traditional /notebook commands
  if (commandHandler.isValidSlashCommand()) {
    const response = await commandHandler.handleSlashCommand();

    // Send command response back to Slack
    await slackClient.sendMessage({
      channel: slackEvent.channel,
      text: response,
    });

    logger.debug(`Slack command response: ${response}`);
    return res.status(200).json({ message: response });
  }

  // Send a "thinking" message (in thread)
  const thinkingMessageTs =
    (await slackClient.sendMessage({
      channel: slackEvent.channel,
      text: `${createLoadingBar(5)} Starting...`,
      threadTs: replyThreadTs,
    })) || null;

  // Create status callback to update the thinking message
  // Status updates are best-effort - failures are logged but don't stop processing
  const updateStatus = async (status: string) => {
    if (thinkingMessageTs) {
      const success = await slackClient.updateMessage({
        channel: slackEvent.channel,
        ts: thinkingMessageTs,
        text: status,
      });
      if (!success) {
        logger.warn('Status update failed', { status: status.substring(0, 50) });
      }
    }
  };

  // Process file attachments if present
  let fabFileIds: string[] = [];
  let fileMetadata: Array<{ fabFileId: string; filename: string; mimeType: string; sizeBytes: number }> = [];
  let fileErrors: string[] = [];

  if (slackEvent.hasFiles) {
    logger.debug('Processing file attachments', {
      fileCount: slackEvent.files.length,
      files: slackEvent.files.map((f: any) => ({ name: f.name, type: f.mimetype, size: f.size })),
    });

    if (updateStatus) {
      await updateStatus(`${createLoadingBar(10)} Processing ${slackEvent.files.length} attached file(s)...`);
    }

    const fileResult = await commandHandler.processSlackFiles(slackEvent.files, updateStatus);

    fabFileIds = fileResult.fabFileIds;
    fileMetadata = fileResult.fileMetadata;
    fileErrors = fileResult.errors;

    // Send error notifications to user
    if (fileErrors.length > 0) {
      await slackClient.sendMessage({
        channel: slackEvent.channel,
        text: fileErrors.join('\n'),
        threadTs: replyThreadTs,
      });
    }

    if (fabFileIds.length > 0) {
      logger.debug('Successfully processed files', {
        fabFileIds,
        fileMetadata,
        successCount: fabFileIds.length,
        errorCount: fileErrors.length,
      });
    }
  }

  const systemPrompt = await buildSystemPrompt({
    pendingAction: questWithPending?.pendingAction
      ? {
          tool: questWithPending.pendingAction.tool,
          params: questWithPending.pendingAction.params,
          ts: questWithPending.pendingAction.ts,
        }
      : undefined,
    channelMessages: contextMessages as Array<{ bot_id?: string; user?: string; text?: string }>,
    getUserName: (userId: string) => slackClient.getUserName(userId),
    user,
    slackUserId: slackEvent.user,
    logger,
  });
  req.logger.info(systemPrompt);

  // Build command with file metadata context for upload tools
  // This tells the AI which fabFileId to use when delegating file uploads
  let commandToSend = commandHandler.parsedCommand.command;
  if (fileMetadata.length > 0) {
    const fileContextLines = fileMetadata.map(
      f => `  - "${f.filename}" (${f.mimeType}, ${Math.round(f.sizeBytes / 1024)}KB) → fabFileId: ${f.fabFileId}`
    );
    const fileContext = `\n\n[Attached files — when the user asks to upload or attach these, delegate via delegate_to_agent and pass the fabFileIds below via the attachedFiles parameter]\n${fileContextLines.join('\n')}`;
    commandToSend = commandToSend + fileContext;
    logger.debug('Added file metadata context to command', {
      fileCount: fileMetadata.length,
      contextLength: fileContext.length,
    });
  }

  // Prepare slackNotification data for async message editing
  // This is stored on the Quest BEFORE waiting for AI, so Quest Processor can edit
  // the message if Frontend Lambda times out
  const effectiveWorkspaceId = workspace?.id || orgWorkspaceId;
  const slackNotificationData =
    thinkingMessageTs && effectiveWorkspaceId
      ? {
          workspaceId: effectiveWorkspaceId,
          channelId: slackEvent.channel,
          threadTs: replyThreadTs,
          messageTs: thinkingMessageTs,
        }
      : undefined;

  const aiResponse = await sendMessageToNotebookAndGetResponse(
    notebookId,
    user!.id,
    commandToSend,
    systemPrompt,
    logger,
    commandHandler,
    updateStatus,
    fabFileIds,
    slackNotificationData, // Pass to store on Quest immediately after creation
    false, // Return early for large tables - Quest Processor handles response
    pendingActionTools // Additional tools (confirm/cancel) when pending action exists
  );

  // Replace thinking message with AI response
  if (aiResponse && thinkingMessageTs) {
    // Look up the latest Quest's pendingAction (set by ChatCompletionProcess when MCP tool returns _confirmToken)
    // The token is stripped from the tool result before AI sees it, so we need to look it up from the Quest
    const questWithPendingAction = await Quest.findOne({
      sessionId: notebookId,
    }).sort({ createdAt: -1 });

    // Atomically clear slackNotification if it exists (prevents double-edit race with Quest Processor)
    // Using findOneAndUpdate with filter ensures we only clear if it still exists
    if (questWithPendingAction) {
      const cleared = await Quest.findOneAndUpdate(
        { _id: questWithPendingAction._id, slackNotification: { $exists: true } },
        { $unset: { slackNotification: 1 } }
      );
      if (cleared) {
        logger.debug('🔔 [ASYNC-NOTIFY] Cleared slackNotification (Frontend Lambda handling edit)');
      }
    }

    // Create rich formatted blocks (tables extracted into Slack native table attachments)
    let formatted = formatAgentResponse(commandHandler.parsedCommand.agentName || 'agent', aiResponse, undefined);

    // Add custom agent indicator if using a custom agent
    if (commandHandler.isUsingCustomAgent()) {
      formatted.blocks.unshift({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Responding as *${commandHandler.agent().name}*_` }],
      });
    }

    // Add confirmation buttons and formatted preview if there's a pending MCP action
    // (skip image_generation - handled separately below with model picker)
    if (questWithPendingAction?.pendingAction && questWithPendingAction.pendingAction.tool !== 'image_generation') {
      const questId = questWithPendingAction._id.toString();
      const { tool, params } = questWithPendingAction.pendingAction;
      logger.debug('🔐 [CONFIRMATION] Found pendingAction on Quest, adding buttons', {
        questId,
        tool,
      });

      // Format preview from params instead of relying on AI
      const formattedPreview = formatPreviewFromParams(tool, params as Record<string, unknown>);

      // Rebuild response blocks with the formatted preview
      formatted = formatAgentResponse(commandHandler.parsedCommand.agentName || 'agent', formattedPreview, undefined);

      const confirmButtons = buildConfirmationButtons(questId);
      formatted.blocks = [...formatted.blocks, ...confirmButtons];
      logger.debug('🔐 [CONFIRMATION] Added formatted preview and confirmation buttons');
    }

    // Add attachment download buttons if there's an attachment list
    if (questWithPendingAction?.attachmentList?.attachments?.length) {
      const { source, issueKey, pageId, attachments } = questWithPendingAction.attachmentList;
      logger.debug('📎 [ATTACHMENTS] Found attachment list on Quest, adding download buttons', {
        source,
        count: attachments.length,
      });

      // Convert to AttachmentDownloadInfo format
      const attachmentInfos: AttachmentDownloadInfo[] = attachments.map(att => ({
        source,
        attachmentId: att.id,
        filename: att.filename,
        emoji: att.emoji,
        sizeFormatted: att.sizeFormatted,
        author: att.author,
        issueKey,
        pageId,
      }));

      const downloadButtons = buildAttachmentDownloadButtons(attachmentInfos, questWithPendingAction._id.toString());
      formatted.blocks = [...formatted.blocks, ...downloadButtons];
      logger.debug('📎 [ATTACHMENTS] Added attachment download buttons');
    }

    // Show image model picker if the LLM triggered image_generation without a pre-set model
    // (conversational flow - e.g., "generate an image of a sunset")
    const pendingImg = questWithPendingAction?.pendingAction;
    if (pendingImg?.tool === 'image_generation') {
      const questId = questWithPendingAction!._id.toString();
      const imgPrompt = (pendingImg.params as { prompt?: string }).prompt || '';
      const pickerBlocks = buildImageModelPicker(questId, imgPrompt);

      // Replace thinking message with the model picker
      await slackClient.updateMessage({
        channel: slackEvent.channel,
        ts: thinkingMessageTs,
        text: '🎨 Choose an image model:',
        blocks: pickerBlocks,
      });

      logger.info('🎨 [IMAGE-GEN] Model picker sent for conversational request', { questId });
      return res.status(200).json({ message: 'Image model picker sent' });
    }

    // Upload generated images if present (rare: generation completed within Lambda timeout)
    if (questWithPendingAction?.images?.length) {
      logger.info('🎨 [IMAGE-GEN] Uploading generated images from sync path', {
        imageCount: questWithPendingAction.images.length,
      });
      for (const imagePath of questWithPendingAction.images) {
        try {
          const imageBuffer = await getGeneratedImageStorage().download(imagePath);
          const filename = imagePath.split('/').pop() || 'generated-image.png';
          await slackClient.uploadFile({
            channel: slackEvent.channel,
            filename,
            content: imageBuffer,
            threadTs: replyThreadTs,
          });
        } catch (imgError) {
          logger.error('🎨 [IMAGE-GEN] Failed to upload image', { imagePath, error: imgError });
        }
      }
    }

    // Show completion status briefly before replacing with response
    const completionUpdateSuccess = await slackClient.updateMessage({
      channel: slackEvent.channel,
      ts: thinkingMessageTs,
      text: `${createLoadingBar(100)} Complete!`,
      blocks: formatted.blocks,
    });
    if (completionUpdateSuccess) {
      // Wait a brief moment to show completion
      await new Promise(resolve => setTimeout(resolve, 500));
      // Truncate text to avoid Slack's msg_too_long error. The `text` field is only
      // a notification/accessibility fallback - blocks carry the actual response.
      const truncatedText = aiResponse.length > 3000 ? aiResponse.slice(0, 2997) + '...' : aiResponse;
      const finalUpdateSuccess = await slackClient.updateMessage({
        channel: slackEvent.channel,
        ts: thinkingMessageTs,
        text: truncatedText,
        blocks: formatted.blocks,
      });
      // If the second update still fails, just log it - the first update already
      // delivered the response in blocks. Sending a new message here causes duplicates.
      if (!finalUpdateSuccess) {
        logger.warn(
          '[Slack Response] Second updateMessage failed — skipping fallback (first update already delivered response in blocks)',
          {
            channel: slackEvent.channel,
            thinkingMessageTs,
            aiResponseLength: aiResponse.length,
          }
        );
      }
    } else {
      // If completion update failed, skip the delay and try to send response as new message
      logger.warn(
        '[Slack Response] Completion updateMessage failed — sending NEW message as fallback (may cause duplicate)',
        {
          channel: slackEvent.channel,
          thinkingMessageTs,
        }
      );
      const truncatedFallbackText = aiResponse.length > 3000 ? aiResponse.slice(0, 2997) + '...' : aiResponse;
      await slackClient.sendMessage({
        channel: slackEvent.channel,
        text: truncatedFallbackText,
        threadTs: replyThreadTs,
        blocks: formatted.blocks,
      });
    }
  } else if (thinkingMessageTs) {
    // If no AI response, update with error message
    const errorUpdateSuccess = await slackClient.updateMessage({
      channel: slackEvent.channel,
      ts: thinkingMessageTs,
      text: "❌ Sorry, I couldn't generate a response. Please try again.",
    });

    // If error update failed, send as new message
    if (!errorUpdateSuccess) {
      logger.warn('Error message update failed, sending as new message');
      await slackClient.sendMessage({
        channel: slackEvent.channel,
        text: "❌ Sorry, I couldn't generate a response. Please try again.",
        threadTs: replyThreadTs,
      });
    }
  }

  // Log command completed
  logEvent({
    type: SlackEvents.SLACK_COMMAND_COMPLETED,
    userId: user!.id,
    metadata: {
      success: !!aiResponse,
      durationMs: Date.now() - commandStartTime,
    },
  }).catch(err =>
    logger.error('Failed to log SLACK_COMMAND_COMPLETED event', {
      error: err instanceof Error ? err.message : typeof err === 'object' ? JSON.stringify(err) : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  );

  logger.debug(
    `Message sent to notebook ${notebookId} for user ${user!.id}, AI response: ${aiResponse ? 'sent' : 'none'}`
  );
  messageAuditLogger.setUserId(user!.id);
  messageAuditLogger.setResource('notebook', notebookId);
  messageAuditLogger.success({ aiResponseSent: !!aiResponse });
  return res.status(200).json({ message: 'Message processed and AI response sent' });
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: false, // Disable auto body parsing to get raw body for signature verification
  },
};

export default handler;
