/**
 * The `errorCode` the web MCP confirm route returns when the action a card displayed
 * has been replaced by a newer one. Shared with the client card so a rename on one
 * side fails the build instead of silently disabling the "replaced" state.
 */
export const MCP_ACTION_REPLACED_ERROR_CODE = 'action_replaced';
