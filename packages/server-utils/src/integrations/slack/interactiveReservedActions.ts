import { IMAGE_GEN_MODEL_ACTION_ID } from '@bike4mind/slack';

/**
 * Action ids the interactive endpoint handles itself; a contributed handler may not claim them.
 * Must stay in sync with the literals in handleInteractiveAction (pinned by a source-scan test next to the endpoint).
 * The scan only sees single-quoted `case 'id':`, `action_id === 'id'` and `action_id.startsWith('prefix')`; match ids in
 * one of those forms or the new id goes unchecked.
 */
export const SLACK_INTERACTIVE_RESERVED_ACTIONS = {
  ids: [
    'app_home_help',
    'app_home_settings',
    'org_defaults_edit',
    'channel_config_add',
    'app_home_create_notebook',
    'app_home_view_all',
    'app_home_refresh',
    'create_notebook',
    'set_default_notebook',
    'toggle_auto_create',
    'view_settings',
    'open_config_modal',
    'confirm_action',
    'cancel_action',
    'modal_confirm_att_del',
  ],
  prefixes: [
    'channel_config_edit_',
    'channel_config_remove_',
    'app_home_notebook_',
    IMAGE_GEN_MODEL_ACTION_ID,
    'attachment_menu_',
  ],
} as const;
