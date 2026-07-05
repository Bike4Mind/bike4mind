/**
 * Model Config Handlers
 *
 * Handles org model defaults and per-channel model config actions
 * from the Slack App Home (admin-only features).
 */

import { WebClient } from '@slack/web-api';
import { Logger } from '@bike4mind/observability';
import { IModelConfig, McpServerName } from '@bike4mind/common';
import { getSlackDb } from '../di/registry';
import { SlackClient } from '../SlackClient';
import { AppHomeBuilder } from '../views/AppHomeBuilder';
import { AppHomeDataService, AppHomeNotebook } from '../services/AppHomeDataService';
import { buildOrgModelDefaultsModal, parseOrgModelDefaultsSubmission } from '../modals/OrgModelDefaultsModal';
import { buildChannelModelConfigModal, parseChannelModelConfigSubmission } from '../modals/ChannelModelConfigModal';
import { findUserBySlackId } from './user-lookup';

/** Base payload structure for view_submission events. Individual modal parse functions define their own, more specific value shapes. */
export interface ViewSubmissionPayload {
  type: 'view_submission';
  user: {
    id: string;
    name?: string;
    team_id?: string;
  };
  view: {
    callback_id: string;
    private_metadata?: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            value?: string;
            selected_option?: { value: string };
            selected_channel?: string;
            selected_date?: string;
            selected_time?: string;
          }
        >
      >;
    };
  };
}

/** Response structure for view submission handlers */
export interface ViewSubmissionResponse {
  response_action?: 'errors';
  errors?: Record<string, string>;
}

/**
 * Check if a Slack user is a workspace admin or owner via Slack API
 */
async function isSlackWorkspaceAdmin(slackUserId: string, botToken: string): Promise<boolean> {
  try {
    const slackClient = new SlackClient(botToken, new Logger({ metadata: { component: 'AdminCheck' } }));
    const userInfo = await slackClient.getUserInfo(slackUserId);
    return userInfo?.is_admin === true || userInfo?.is_owner === true;
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to check admin status, denying access', { error, slackUserId });
    return false;
  }
}

/**
 * Handle org_defaults_edit action - open modal for org model defaults
 */
export async function handleOrgDefaultsEdit(
  slackUserId: string,
  triggerId?: string,
  botToken?: string
): Promise<Record<string, unknown>> {
  if (!triggerId || !botToken) {
    return { text: 'Unable to open config - missing trigger or token.' };
  }

  if (!(await isSlackWorkspaceAdmin(slackUserId, botToken))) {
    return { text: 'Only Slack workspace admins can configure org defaults.' };
  }

  const dbUser = await findUserBySlackId(slackUserId);
  if (!dbUser?.organizationId) {
    return { text: 'Please link your account and ensure your organization is set up.' };
  }

  try {
    const { Organization } = getSlackDb();
    const org = await (Organization as any)
      .findById(dbUser.organizationId)
      .select('preferredModel temperature maxTokens')
      .lean();

    const client = new WebClient(botToken);
    await client.views.open({
      trigger_id: triggerId,
      view: await buildOrgModelDefaultsModal({
        organizationId: dbUser.organizationId,
        preferredModel: org?.preferredModel,
        temperature: org?.temperature,
        maxTokens: org?.maxTokens,
      }),
    });
    return {};
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to open org defaults modal', { error });
    return { text: 'Failed to open configuration dialog.' };
  }
}

/**
 * Handle org model defaults modal submission
 */
export async function handleOrgModelDefaultsSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string
): Promise<ViewSubmissionResponse> {
  const { view, user } = payload;
  const logger = new Logger({ metadata: { component: 'OrgModelDefaults' } });

  const submission = parseOrgModelDefaultsSubmission(view.state.values, view.private_metadata || '{}');

  if ('error' in submission) {
    logger.warn('[Slack Interactive] Org model defaults validation failed', { error: submission.error });
    return {
      response_action: 'errors',
      errors: {
        model_block: submission.error,
      },
    };
  }

  try {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    if (submission.preferredModel !== undefined) $set.preferredModel = submission.preferredModel;
    else $unset.preferredModel = 1;

    if (submission.temperature !== undefined) $set.temperature = submission.temperature;
    else $unset.temperature = 1;

    if (submission.maxTokens !== undefined) $set.maxTokens = submission.maxTokens;
    else $unset.maxTokens = 1;

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    if (Object.keys(update).length > 0) {
      const { Organization: OrgModel } = getSlackDb();
      await (OrgModel as any).findByIdAndUpdate(submission.organizationId, update);
    }

    logger.info('[Slack Interactive] Org model defaults saved', {
      organizationId: submission.organizationId,
      $set: Object.keys($set),
      $unset: Object.keys($unset),
      slackUserId: user.id,
    });

    return {};
  } catch (error) {
    logger.error('[Slack Interactive] Failed to save org model defaults', { error });
    return {
      response_action: 'errors',
      errors: {
        model_block: 'Failed to save defaults. Please try again.',
      },
    };
  }
}

/**
 * Handle channel_config_add action - open modal for new channel config
 */
export async function handleChannelConfigAdd(
  slackUserId: string,
  slackTeamId?: string,
  triggerId?: string,
  botToken?: string
): Promise<Record<string, unknown>> {
  if (!triggerId || !botToken || !slackTeamId) {
    return { text: 'Unable to open config - missing trigger, token, or workspace.' };
  }

  if (!(await isSlackWorkspaceAdmin(slackUserId, botToken))) {
    return { text: 'Only Slack workspace admins can configure channel models.' };
  }

  try {
    const client = new WebClient(botToken);
    await client.views.open({
      trigger_id: triggerId,
      view: await buildChannelModelConfigModal({ slackTeamId }),
    });
    return {};
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to open channel config modal', { error });
    return { text: 'Failed to open configuration dialog.' };
  }
}

/**
 * Handle channel_config_edit action - open modal pre-filled with existing config
 */
export async function handleChannelConfigEdit(
  slackUserId: string,
  channelId: string,
  slackTeamId?: string,
  triggerId?: string,
  botToken?: string
): Promise<Record<string, unknown>> {
  if (!triggerId || !botToken || !slackTeamId) {
    return { text: 'Unable to open config - missing trigger, token, or workspace.' };
  }

  if (!(await isSlackWorkspaceAdmin(slackUserId, botToken))) {
    return { text: 'Only Slack workspace admins can configure channel models.' };
  }

  try {
    const { slackChannelConfigRepository } = getSlackDb();
    const existing = await (slackChannelConfigRepository as any).findByChannelId(channelId);
    const client = new WebClient(botToken);
    await client.views.open({
      trigger_id: triggerId,
      view: await buildChannelModelConfigModal({
        slackTeamId,
        channelId,
        preferredModel: existing?.preferredModel,
        temperature: existing?.temperature,
        maxTokens: existing?.maxTokens,
      }),
    });
    return {};
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to open channel config edit modal', { error, channelId });
    return { text: 'Failed to open configuration dialog.' };
  }
}

/**
 * Handle channel_config_remove action - delete config and refresh App Home
 */
export async function handleChannelConfigRemove(
  slackUserId: string,
  channelId: string,
  slackTeamId?: string,
  botToken?: string,
  appName?: string
): Promise<Record<string, unknown>> {
  if (!botToken || !slackTeamId || !(await isSlackWorkspaceAdmin(slackUserId, botToken))) {
    return { text: 'Only Slack workspace admins can remove channel configs.' };
  }

  try {
    const { slackChannelConfigRepository: channelConfigRepo } = getSlackDb();
    await (channelConfigRepo as any).deleteByChannelId(channelId);
    Logger.info('[Slack Interactive] Channel config removed', { channelId, slackUserId });

    return {};
  } catch (error) {
    Logger.error('[Slack Interactive] Failed to remove channel config', { error, channelId });
    return { text: 'Failed to remove channel configuration.' };
  }
}

/**
 * Handle channel model config modal submission
 */
export async function handleChannelModelConfigSubmission(
  payload: ViewSubmissionPayload,
  botToken?: string
): Promise<ViewSubmissionResponse> {
  const { view, user } = payload;
  const logger = new Logger({ metadata: { component: 'ChannelModelConfig' } });

  const submission = parseChannelModelConfigSubmission(view.state.values, view.private_metadata || '{}');

  if ('error' in submission) {
    logger.warn('[Slack Interactive] Channel model config validation failed', { error: submission.error });
    return {
      response_action: 'errors',
      errors: {
        model_block: submission.error,
      },
    };
  }

  try {
    const { slackChannelConfigRepository: channelConfigRepoForUpsert } = getSlackDb();
    await (channelConfigRepoForUpsert as any).upsertByChannelId(submission.channelId, {
      slackTeamId: submission.slackTeamId,
      preferredModel: submission.preferredModel,
      temperature: submission.temperature,
      maxTokens: submission.maxTokens,
      configuredBy: user.id,
    });

    logger.info('[Slack Interactive] Channel model config saved', {
      channelId: submission.channelId,
      model: submission.preferredModel,
      slackUserId: user.id,
    });

    return {};
  } catch (error) {
    logger.error('[Slack Interactive] Failed to save channel model config', { error });
    return {
      response_action: 'errors',
      errors: {
        model_block: 'Failed to save configuration. Please try again.',
      },
    };
  }
}

/**
 * Helper to refresh App Home for an admin user (after config changes)
 */
export async function refreshAppHomeForAdmin(
  slackUserId: string,
  slackTeamId: string,
  botToken: string,
  appName?: string
): Promise<void> {
  try {
    const refreshLogger = new Logger({ metadata: { component: 'AppHomeRefreshAdmin' } });
    const slackClient = new SlackClient(botToken, refreshLogger);

    const dbUser = await findUserBySlackId(slackUserId);

    let notebooks: AppHomeNotebook[] = [];
    let stats = { totalNotebooks: 0, messagesThisWeek: 0, activeProjects: 0 };
    let hasGitHubConnected = false;
    let hasJiraConnected = false;

    if (dbUser) {
      const dataService = new AppHomeDataService();
      const appHomeData = await dataService.fetchAppHomeData(dbUser.id);
      notebooks = appHomeData.notebooks;
      stats = appHomeData.stats;

      const { McpServer: McpServerModel } = getSlackDb();
      const githubMcpServer = await (McpServerModel as any).findOne({
        userId: dbUser.id,
        name: McpServerName.Github,
        enabled: true,
      });
      hasGitHubConnected = !!githubMcpServer;
      hasJiraConnected =
        !!dbUser.atlassianConnect?.accessToken && dbUser.atlassianConnect?.status !== 'needs_reconnect';
    }

    const slackUserInfo = await slackClient.getUserInfo(slackUserId);
    const displayName = slackUserInfo?.real_name || slackUserInfo?.name;

    // Load org defaults (if user has an org) and channel configs (by workspace)
    let orgDefaults: IModelConfig | undefined;

    const { slackChannelConfigRepository: channelConfigRepoForRefresh } = getSlackDb();
    const configs = await (channelConfigRepoForRefresh as any).findBySlackTeamId(slackTeamId);
    const channelConfigs = configs.map((c: any) => ({
      channelId: c.channelId,
      preferredModel: c.preferredModel,
      temperature: c.temperature,
      maxTokens: c.maxTokens,
    }));

    if (dbUser?.organizationId) {
      const { Organization: OrgModelRefresh } = getSlackDb();
      const org = await (OrgModelRefresh as any)
        .findById(dbUser.organizationId)
        .select('preferredModel temperature maxTokens')
        .lean();
      if (org) {
        orgDefaults = { preferredModel: org.preferredModel, temperature: org.temperature, maxTokens: org.maxTokens };
      }
    }

    const homeBuilder = new AppHomeBuilder({
      slackUserId,
      displayName,
      hasGitHubConnected,
      hasJiraConnected,
      appName,
      notebooks,
      stats,
      isLinked: !!dbUser,
      webAppBaseUrl: process.env.APP_URL,
      isAdmin: true,
      orgDefaults,
      channelConfigs,
    });

    await slackClient.publishHomeView(slackUserId, homeBuilder.build());
  } catch (error) {
    Logger.warn('[Slack Interactive] Failed to refresh App Home after config change', { error });
  }
}
