/** Only the OAuth callback writes the team binding; legacy typed member IDs have none. */
export const VERIFIED_SLACK_IDENTITY_FILTER = {
  'slackSettings.slackTeamId': { $type: 'string', $ne: '' },
} as const;

/**
 * Match the account linked to this Slack member in this workspace. Callers must pass the team of
 * the verified request so a member id is only resolved inside the workspace it was linked from.
 */
export function slackIdentityFilter(slackUserId: string, slackTeamId: string) {
  return {
    'slackSettings.slackUserId': slackUserId,
    'slackSettings.slackTeamId': slackTeamId,
  } as const;
}
