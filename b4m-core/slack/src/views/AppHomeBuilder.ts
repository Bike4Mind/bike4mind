import { KnownBlock, Block } from '@slack/web-api';
import type { IModelConfig } from '@bike4mind/common';
import { AppHomeNotebook, AppHomeStats, formatRelativeTime } from '../services/AppHomeDataService';
import { SYSTEM_MODEL_DEFAULTS } from '../constants/system-model-defaults';

/**
 * Slack Button element for ActionsBlock
 */
interface SlackButtonElement {
  type: 'button';
  text: {
    type: 'plain_text';
    text: string;
    emoji?: boolean;
  };
  action_id: string;
  style?: 'primary' | 'danger';
  url?: string;
}

/**
 * User context for building personalized App Home views
 */
export interface ChannelConfigSummary extends IModelConfig {
  channelId: string;
  githubOwner?: string;
  githubRepo?: string;
}

export interface AppHomeUserContext {
  slackUserId: string;
  displayName?: string;
  hasGitHubConnected?: boolean;
  hasJiraConnected?: boolean;
  appName?: string; // Bot/app name from workspace settings
  notebooks?: AppHomeNotebook[];
  stats?: AppHomeStats;
  isLinked?: boolean; // Whether user has linked their Slack to B4M account
  webAppBaseUrl?: string; // Base URL for web app links (e.g., https://your-deployment.example.com)
  isAdmin?: boolean;
  orgDefaults?: IModelConfig;
  channelConfigs?: ChannelConfigSummary[];
}

/**
 * AppHomeBuilder creates Block Kit views for the Slack App Home tab
 *
 * The App Home is a dedicated space for users to interact with B4M
 * without leaving Slack. Sections: welcome header, usage stats,
 * recent notebooks, quick actions, integrations status, and
 * admin-only AI model settings (org defaults + channel overrides).
 */
export class AppHomeBuilder {
  private userContext: AppHomeUserContext;

  constructor(userContext: AppHomeUserContext) {
    this.userContext = userContext;
  }

  /**
   * Build the complete App Home view blocks
   */
  build(): (KnownBlock | Block)[] {
    const blocks: (KnownBlock | Block)[] = [];

    // Header section
    blocks.push(...this.buildHeader());

    // Statistics section (if user has data)
    if (this.userContext.stats && this.userContext.stats.totalNotebooks > 0) {
      blocks.push({ type: 'divider' });
      blocks.push(...this.buildStatsSection());
    }

    // Recent notebooks section
    blocks.push({ type: 'divider' });
    blocks.push(...this.buildNotebooksSection());

    blocks.push({ type: 'divider' });

    // Quick actions section
    blocks.push(...this.buildQuickActions());

    blocks.push({ type: 'divider' });

    // Connected integrations section
    blocks.push(...this.buildIntegrationsStatus());

    // Admin: channel model settings section
    if (this.userContext.isAdmin) {
      blocks.push({ type: 'divider' });
      blocks.push(...this.buildChannelModelSection());
    }

    return blocks;
  }

  /**
   * Build the welcome header section
   */
  private buildHeader(): (KnownBlock | Block)[] {
    const appName = this.userContext.appName || 'Assistant';
    const greeting = this.userContext.displayName
      ? `Welcome, ${this.userContext.displayName}!`
      : `Welcome to ${appName}!`;

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: appName,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${greeting}\n\nYour AI-powered project assistant. Use the actions below or mention *@dev*, *@pm*, or *@qa* in any channel to get started.`,
        },
      },
    ];
  }

  /**
   * Build statistics section
   */
  private buildStatsSection(): (KnownBlock | Block)[] {
    const { stats } = this.userContext;
    if (!stats) return [];

    const notebookText = stats.totalNotebooks === 1 ? '1 notebook' : `${stats.totalNotebooks} notebooks`;
    const messageText =
      stats.messagesThisWeek === 1 ? '1 message this week' : `${stats.messagesThisWeek} messages this week`;
    const projectText = stats.activeProjects === 1 ? '1 project' : `${stats.activeProjects} projects`;

    return [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `📊 *${notebookText}* • ${messageText} • ${projectText}`,
          },
        ],
      },
    ];
  }

  /**
   * Build recent notebooks section
   */
  private buildNotebooksSection(): (KnownBlock | Block)[] {
    const { notebooks, isLinked } = this.userContext;
    const blocks: (KnownBlock | Block)[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Recent Notebooks*',
      },
    });

    // Unlinked user state - show link account prompt
    if (!isLinked) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '*Link your account to get started*\n\n' +
            'Connect your Slack to your account to:\n' +
            '• Access and create notebooks\n' +
            '• Use GitHub and Jira integrations\n' +
            '• Chat with AI agents\n\n' +
            '_Visit your profile settings on the web app to link your Slack account._',
        },
      });
      return blocks;
    }

    // Empty state for linked users with no notebooks
    if (!notebooks || notebooks.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "_You don't have any notebooks yet._\nCreate one to get started!",
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '📝 New Notebook',
            emoji: true,
          },
          action_id: 'app_home_create_notebook',
          style: 'primary',
        },
      });
      return blocks;
    }

    // Display notebooks (max 5)
    const displayNotebooks = notebooks.slice(0, 5);
    const { webAppBaseUrl } = this.userContext;
    for (const notebook of displayNotebooks) {
      const relativeTime = formatRelativeTime(new Date(notebook.lastUpdated));
      const notebookUrl = webAppBaseUrl ? `${webAppBaseUrl}/notebooks/${notebook.id}` : undefined;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📓 *${notebook.name}*\n_${relativeTime}_`,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Open',
            emoji: true,
          },
          action_id: `app_home_notebook_${notebook.id}`,
          ...(notebookUrl && { url: notebookUrl }),
        },
      });
    }

    return blocks;
  }

  /**
   * Build quick action buttons section
   */
  private buildQuickActions(): (KnownBlock | Block)[] {
    const { notebooks, isLinked, webAppBaseUrl } = this.userContext;
    const hasNotebooks = notebooks && notebooks.length > 0;

    const elements: SlackButtonElement[] = [];

    if (hasNotebooks) {
      elements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: '📝 New Notebook',
          emoji: true,
        },
        action_id: 'app_home_create_notebook',
        style: 'primary',
      });

      // View All button - opens web app with notebook sidebar visible
      const viewAllUrl = webAppBaseUrl ? `${webAppBaseUrl}/new` : undefined;
      elements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: '📋 View All',
          emoji: true,
        },
        action_id: 'app_home_view_all',
        ...(viewAllUrl && { url: viewAllUrl }),
      });
    }

    // Refresh button - show for all linked users (not just those with notebooks)
    if (isLinked) {
      elements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: '🔄 Refresh',
          emoji: true,
        },
        action_id: 'app_home_refresh',
      });
    }

    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '❓ Help',
        emoji: true,
      },
      action_id: 'app_home_help',
      ...(hasNotebooks ? {} : { style: 'primary' }),
    });

    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: '⚙️ Settings',
        emoji: true,
      },
      action_id: 'app_home_settings',
    });

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Quick Actions*',
        },
      },
      {
        type: 'actions',
        elements,
      },
    ];
  }

  /**
   * Build AI model settings section (admin-only)
   * Contains org defaults at top, channel overrides below.
   */
  private buildChannelModelSection(): (KnownBlock | Block)[] {
    const { orgDefaults, channelConfigs } = this.userContext;
    const blocks: (KnownBlock | Block)[] = [];

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*AI Model Settings*',
      },
    });

    // --- Default Settings ---
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Default Settings*',
      },
    });

    const orgParts: string[] = [];
    if (orgDefaults?.preferredModel) orgParts.push(`Model: \`${orgDefaults.preferredModel}\``);
    if (orgDefaults?.temperature !== undefined) orgParts.push(`Temp: ${orgDefaults.temperature}`);
    if (orgDefaults?.maxTokens !== undefined) orgParts.push(`Tokens: ${orgDefaults.maxTokens}`);
    const orgDetail =
      orgParts.length > 0
        ? orgParts.join(' | ')
        : `_Using system defaults (${SYSTEM_MODEL_DEFAULTS.modelDisplayName} | ${SYSTEM_MODEL_DEFAULTS.temperature} | ${SYSTEM_MODEL_DEFAULTS.maxTokens})_`;

    // Show Edit button only if user has an org (orgDefaults is set when org exists)
    if (orgDefaults) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: orgDetail,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Edit',
            emoji: true,
          },
          action_id: 'org_defaults_edit',
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: orgDetail,
        },
      });
    }

    // --- Channel Overrides ---
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Channel Overrides*',
      },
    });

    if (!channelConfigs || channelConfigs.length === 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '_No channel overrides configured. All channels use default settings._',
          },
        ],
      });
    } else {
      for (const cfg of channelConfigs) {
        const parts: string[] = [];
        if (cfg.preferredModel) parts.push(`Model: \`${cfg.preferredModel}\``);
        if (cfg.temperature !== undefined) parts.push(`Temp: ${cfg.temperature}`);
        if (cfg.maxTokens !== undefined) parts.push(`Tokens: ${cfg.maxTokens}`);
        if (cfg.githubOwner && cfg.githubRepo) parts.push(`Repo: \`${cfg.githubOwner}/${cfg.githubRepo}\``);
        const detail = parts.length > 0 ? parts.join(' | ') : '_defaults_';

        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<#${cfg.channelId}> → ${detail}`,
            },
          ],
        });

        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Edit',
                emoji: true,
              },
              action_id: `channel_config_edit_${cfg.channelId}`,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Remove',
                emoji: true,
              },
              action_id: `channel_config_remove_${cfg.channelId}`,
              style: 'danger',
            },
          ],
        });
      }
    }

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Configure Channel',
            emoji: true,
          },
          action_id: 'channel_config_add',
          style: 'primary',
        },
      ],
    });

    return blocks;
  }

  /**
   * Build connected integrations status section
   */
  private buildIntegrationsStatus(): (KnownBlock | Block)[] {
    const { hasGitHubConnected, hasJiraConnected } = this.userContext;

    const githubStatus = hasGitHubConnected ? ':white_check_mark: GitHub connected' : ':x: GitHub not connected';
    const jiraStatus = hasJiraConnected ? ':white_check_mark: Jira connected' : ':x: Jira not connected';

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Connected Integrations*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${githubStatus}\n${jiraStatus}`,
        },
      },
    ];
  }
}

/**
 * Build an error fallback view when something goes wrong
 */
export function buildErrorHomeView(appName?: string, errorMessage?: string): (KnownBlock | Block)[] {
  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: appName || 'Assistant',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚠️ Something went wrong loading your dashboard. Please try again later.',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: errorMessage ? `_Error: ${errorMessage}_` : '_If this persists, please contact support._',
        },
      ],
    },
  ];
}
