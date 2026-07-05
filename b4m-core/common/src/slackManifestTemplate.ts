/**
 * Slack App Manifest Template
 *
 * Defines the "controlled fields" we own (scopes, events, commands, etc.)
 * separately from user-customizable fields (name, description, color).
 *
 * Used for:
 * - Creating new Slack apps (full manifest)
 * - Comparing live manifests to detect drift
 * - Merging updates into live manifests without overwriting user customizations
 */

export interface ControlledManifestFields {
  oauth_config: {
    scopes: {
      bot: string[];
      user: string[];
    };
    redirect_urls: string[];
  };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    slash_commands: Array<{
      command: string;
      url: string;
      description: string;
      should_escape: boolean;
    }>;
    shortcuts: Array<{
      name: string;
      type: string;
      callback_id: string;
      description: string;
    }>;
  };
  functions?: Record<
    string,
    {
      title: string;
      description: string;
      input_parameters: Record<string, { type: string; title: string; description: string; is_required: boolean }>;
      output_parameters: Record<string, { type: string; title: string; description: string }>;
    }
  >;
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
      request_url: string;
    };
    function_runtime?: string;
  };
}

export interface FullManifest extends ControlledManifestFields {
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: ControlledManifestFields['features'] & {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
  };
  settings: ControlledManifestFields['settings'] & {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
  oauth_config: ControlledManifestFields['oauth_config'];
}

/**
 * Returns just the OAuth scopes from the manifest template.
 * Use this when you only need scopes (e.g., OAuth installer) to avoid generating URLs with a dummy baseUrl.
 */
export function getControlledScopes(): { bot: string[]; user: string[] } {
  return {
    bot: [
      'app_mentions:read',
      'channels:history',
      'channels:manage',
      'channels:read',
      'chat:write',
      'commands',
      'files:write',
      'groups:history',
      'groups:read',
      'groups:write',
      'im:history',
      'im:read',
      'im:write',
      'mpim:history',
      'mpim:read',
      'mpim:write',
      'users:read',
      'users:read.email',
      'files:read',
    ],
    user: ['reminders:write', 'identity.basic', 'search:read'],
  };
}

/**
 * Returns the fields we control - scopes, events, commands, interactivity, app_home.
 * These are the fields we compare against the live manifest to detect drift.
 */
export function getControlledManifestFields(
  baseUrl: string,
  options?: { enableWorkflowSteps?: boolean; appName?: string }
): ControlledManifestFields {
  const enableWorkflowSteps = options?.enableWorkflowSteps ?? true;
  // Brand name woven into user-facing command/shortcut/function copy. Externalized for
  // open-core: callers pass it (server: process.env.APP_NAME; client:
  // NEXT_PUBLIC_APP_NAME) so this module stays isomorphic and free of process.env reads.
  // Empty == copy drops the brand and reads generically (e.g. "Create a new notebook").
  const brand = (options?.appName ?? '').trim();

  const botEvents = [
    'app_home_opened',
    'app_mention',
    ...(enableWorkflowSteps ? ['function_executed'] : []),
    'message.channels',
    'message.groups',
    'message.im',
    'message.mpim',
  ];

  return {
    oauth_config: {
      scopes: getControlledScopes(),
      redirect_urls: [
        `${baseUrl}/api/slack/oauth/callback`,
        `${baseUrl}/api/slack/oauth/user-link/callback`,
        `${baseUrl}/api/slack/oauth/org-connect/callback`,
      ],
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: [
        {
          command: '/notebook',
          url: `${baseUrl}/api/slack/commands`,
          description: 'Manage notebooks',
          should_escape: false,
        },
        {
          command: '/b4m',
          url: `${baseUrl}/api/slack/commands`,
          description: 'Schedule messages and more',
          should_escape: false,
        },
        {
          command: '/channel',
          url: `${baseUrl}/api/slack/commands`,
          description: 'Manage channels',
          should_escape: false,
        },
        {
          command: '/paint',
          url: `${baseUrl}/api/slack/commands`,
          description: 'Paint an image with AI',
          should_escape: false,
        },
      ],
      shortcuts: [
        {
          name: 'Create Notebook',
          type: 'global',
          callback_id: 'create_notebook_shortcut',
          description: brand ? `Create a new notebook in ${brand}` : 'Create a new notebook',
        },
        {
          name: 'View My Notebooks',
          type: 'global',
          callback_id: 'view_notebooks_shortcut',
          description: 'View and manage your notebooks',
        },
        {
          name: brand ? `Quick Ask ${brand}` : 'Quick Ask',
          type: 'global',
          callback_id: 'quick_ask_shortcut',
          description: brand ? `Ask ${brand} a quick question` : 'Ask a quick question',
        },
        {
          name: 'Help',
          type: 'global',
          callback_id: 'help_shortcut',
          description: brand ? `Get help with ${brand} features` : 'Get help with app features',
        },
      ],
    },
    ...(enableWorkflowSteps
      ? {
          functions: {
            b4m_create_notebook: {
              title: 'Create Notebook',
              description: brand ? `Create a new ${brand} notebook` : 'Create a new notebook',
              input_parameters: {
                user_id: {
                  type: 'slack#/types/user_id',
                  title: 'User',
                  description: 'The user who triggered this workflow',
                  is_required: true,
                },
                notebook_name: {
                  type: 'string',
                  title: 'Notebook Name',
                  description: 'Name for the new notebook (optional)',
                  is_required: false,
                },
                send_notification: {
                  type: 'boolean',
                  title: 'Send Notification',
                  description: 'Send a DM with the result (default: no)',
                  is_required: false,
                },
              },
              output_parameters: {
                notebook_id: { type: 'string', title: 'Notebook ID', description: 'ID of the created notebook' },
                notebook_name: {
                  type: 'string',
                  title: 'Notebook Name',
                  description: 'Name of the created notebook',
                },
                notebook_url: { type: 'string', title: 'Notebook URL', description: 'URL to open the notebook' },
              },
            },
            b4m_send_message: {
              title: brand ? `Send to ${brand}` : 'Send Message',
              description: `Send a message${brand ? ` to ${brand}` : ''} and optionally wait for AI response`,
              input_parameters: {
                user_id: {
                  type: 'slack#/types/user_id',
                  title: 'User',
                  description: 'The user who triggered this workflow',
                  is_required: true,
                },
                message: {
                  type: 'string',
                  title: 'Message',
                  description: `Message to send${brand ? ` to ${brand}` : ''}`,
                  is_required: true,
                },
                notebook_id: {
                  type: 'string',
                  title: 'Notebook ID',
                  description: 'Target notebook (uses default if empty)',
                  is_required: false,
                },
                wait_for_response: {
                  type: 'boolean',
                  title: 'Wait for Response',
                  description: 'Wait for AI response before completing',
                  is_required: false,
                },
                send_notification: {
                  type: 'boolean',
                  title: 'Send Notification',
                  description: 'Send a DM with the result (default: no)',
                  is_required: false,
                },
              },
              output_parameters: {
                quest_id: { type: 'string', title: 'Quest ID', description: 'ID of the created quest' },
                response: {
                  type: 'string',
                  title: 'Response',
                  description: 'AI response (if wait_for_response was true)',
                },
                notebook_id: { type: 'string', title: 'Notebook ID', description: 'ID of the notebook used' },
              },
            },
            b4m_query: {
              title: brand ? `Query ${brand}` : 'Query',
              description: `Ask${brand ? ` ${brand}` : ''} a question and get an AI response`,
              input_parameters: {
                user_id: {
                  type: 'slack#/types/user_id',
                  title: 'User',
                  description: 'The user who triggered this workflow',
                  is_required: true,
                },
                query: {
                  type: 'string',
                  title: 'Query',
                  description: `Question to ask${brand ? ` ${brand}` : ''}`,
                  is_required: true,
                },
                notebook_id: {
                  type: 'string',
                  title: 'Notebook ID',
                  description: 'Notebook to query (uses default if empty)',
                  is_required: false,
                },
                send_notification: {
                  type: 'boolean',
                  title: 'Send Notification',
                  description: 'Send a DM with the result (default: no)',
                  is_required: false,
                },
              },
              output_parameters: {
                answer: { type: 'string', title: 'Answer', description: 'AI response to the query' },
                sources: { type: 'string', title: 'Sources', description: 'Referenced notebooks/files' },
                notebook_id: { type: 'string', title: 'Notebook ID', description: 'ID of the notebook used' },
              },
            },
          },
        }
      : {}),
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}/api/slack/events`,
        bot_events: botEvents,
      },
      interactivity: {
        is_enabled: true,
        request_url: `${baseUrl}/api/slack/interactive`,
      },
      ...(enableWorkflowSteps ? { function_runtime: 'remote' as const } : {}),
    },
  };
}

/**
 * Generates a full manifest for creating a new Slack app.
 * Includes both controlled fields and user-customizable fields.
 */
export function generateFullManifest(params: {
  name: string;
  description: string;
  backgroundColor: string;
  baseUrl: string;
  enableWorkflowSteps?: boolean;
  /** Brand name woven into command/shortcut copy. Defaults to the app display name. */
  appName?: string;
}): FullManifest {
  const enableWorkflowSteps = params.enableWorkflowSteps ?? true;
  const controlled = getControlledManifestFields(params.baseUrl, {
    enableWorkflowSteps,
    appName: params.appName ?? params.name,
  });

  return {
    display_information: {
      name: params.name,
      description: params.description,
      background_color: params.backgroundColor,
    },
    features: {
      bot_user: {
        display_name: params.name,
        always_online: false,
      },
      ...controlled.features,
    },
    ...(controlled.functions ? { functions: controlled.functions } : {}),
    oauth_config: controlled.oauth_config,
    settings: {
      ...controlled.settings,
      org_deploy_enabled: enableWorkflowSteps,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
