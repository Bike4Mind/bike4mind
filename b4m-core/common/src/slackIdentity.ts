/** Only the OAuth callback writes the team binding; legacy typed member IDs have none. */
export const VERIFIED_SLACK_IDENTITY_FILTER = {
  'slackSettings.slackTeamId': { $type: 'string', $ne: '' },
} as const;
