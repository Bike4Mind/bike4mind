import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { isSlackUserValidationError } from '@bike4mind/server-utils/integrations/slack/slackExportErrors';
import { withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

/**
 * POST /api/admin/slack-app/create
 * Creates a Slack app from a manifest configuration
 * Admin-only endpoint
 */

const manifestSchema = z.looseObject({
  _metadata: z
    .looseObject({
      major_version: z.number().optional(),
      minor_version: z.number().optional(),
    })
    .optional(),
  display_information: z.looseObject({
    name: z.string().min(1),
    description: z.string().optional(),
    long_description: z.string().optional(),
    background_color: z.string().optional(),
  }),
  features: z.looseObject({
    bot_user: z
      .looseObject({
        display_name: z.string().optional(),
        always_online: z.boolean().optional(),
      })
      .optional(),
    app_home: z
      .looseObject({
        home_tab_enabled: z.boolean().optional(),
        messages_tab_enabled: z.boolean().optional(),
        messages_tab_read_only_enabled: z.boolean().optional(),
      })
      .optional(),
    slash_commands: z
      .array(
        z.looseObject({
          command: z.string(),
          url: z.url(),
          description: z.string().optional(),
          usage_hint: z.string().optional(),
          should_escape: z.boolean().optional(),
        })
      )
      .optional(),
    shortcuts: z
      .array(
        z.looseObject({
          name: z.string(),
          type: z.enum(['global', 'message']).optional(),
          callback_id: z.string().optional(),
          description: z.string().optional(),
        })
      )
      .optional(),
  }),
  oauth_config: z.looseObject({
    redirect_urls: z.tuple([z.url()], z.url()),
    scopes: z
      .looseObject({
        bot: z.array(z.string()).optional(),
        user: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  settings: z.looseObject({
    event_subscriptions: z
      .looseObject({
        request_url: z.url().optional(),
        bot_events: z.array(z.string()).optional(),
        user_events: z.array(z.string()).optional(),
      })
      .optional(),
    interactivity: z
      .looseObject({
        is_enabled: z.boolean().optional(),
        request_url: z.url().optional(),
      })
      .optional(),
    socket_mode_enabled: z.boolean().optional(),
    org_deploy_enabled: z.boolean().optional(),
    token_rotation_enabled: z.boolean().optional(),
  }),
});

const CreateSlackAppSchema = z.object({
  manifest: manifestSchema,
  configToken: z.string().min(1, 'Config token is required'),
  enableWorkflowSteps: z.boolean().optional().default(true),
});

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const result = CreateSlackAppSchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { manifest, configToken, enableWorkflowSteps } = result.data;

  // Call Slack API to create app from manifest using provided config token
  let slackData: Record<string, unknown>;
  try {
    const slackResponse = await fetch('https://slack.com/api/apps.manifest.create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${configToken}`,
      },
      body: JSON.stringify({ manifest }),
    });
    slackData = await slackResponse.json();
  } catch (fetchError) {
    req.logger.error('Network error calling Slack API (apps.manifest.create)', {
      error: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
    throw new BadRequestError('Unable to reach the Slack API. Please try again.');
  }

  // Never log slackData wholesale: its `credentials` carry the app client/signing secrets.
  req.logger.info('Slack manifest create response', { ok: slackData.ok, appId: slackData.app_id });

  if (!slackData.ok) {
    const slackError = slackData.error as string;

    if (isSlackUserValidationError(slackError || '')) {
      req.logger.warn('Slack manifest create auth error (user validation)', { error: slackError });
      throw new BadRequestError('Configuration token is invalid or expired. Please provide a valid token.');
    }

    req.logger.error('Slack API error:', { error: slackData.error, errors: slackData.errors });
    throw new BadRequestError(
      slackError || 'Failed to create Slack app',
      (slackData.errors || slackData.response_metadata) as Record<string, unknown> | undefined
    );
  }

  const credentials = slackData.credentials as Record<string, string>;

  const appName = manifest.display_information.name;

  // A failed audit rolls back the local save; the app already created on Slack is left in place.
  let workspace;
  try {
    workspace = await withTransaction(async () => {
      const saved = await slackDevWorkspaceRepository.createOrUpdateWithCredentials({
        slackBotName: manifest.features.bot_user?.display_name,
        slackAppId: slackData.app_id as string,
        slackClientId: credentials.client_id,
        slackClientSecret: credentials.client_secret,
        slackOAuthSigningSecret: credentials.signing_secret,
        slackOAuthRedirectUri: manifest.oauth_config.redirect_urls[0],
        slackVerificationToken: credentials.verification_token,
        enableWorkflowSteps,
      });

      // Store the config token for future manifest management
      await slackDevWorkspaceRepository.storeConfigToken(saved.id, configToken);

      await recordAdminActionFromRequest(req, {
        action: 'integration.slack_app.created',
        target: { kind: 'settings', id: saved.id, displayName: appName },
        summary: `created slack app ${appName}`,
        details: { appId: slackData.app_id },
      });
      return saved;
    });
  } catch (error) {
    req.logger.error('Slack app was created but saving it locally failed; delete the app manually on Slack', {
      appId: slackData.app_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  req.logger.info('✨ [Admin] Created Slack app from manifest and saved credentials', {
    appId: slackData.app_id,
    workspaceId: workspace.id,
    appName,
    adminUserId: req.user?.id,
  });

  return res.status(200).json({
    success: true,
    appId: slackData.app_id,
  });
});

export default handler;
