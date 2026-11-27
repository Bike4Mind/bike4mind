/**
 * Picks the Slack app row an OAuth flow runs against.
 *
 * `requestedWorkspaceId` is the row the request names (initiation parameter, or the id signed into the
 * OAuth state on the callback). When it is set the row must exist, be active and have credentials: there is
 * deliberately no fallback to another app. When it is absent (a legacy request or state) the first
 * credentialed row is used, matching the order the repository returns (newest install first).
 */
export function selectSlackAppRow<T extends { id: string; slackClientId?: string; slackClientSecret?: string }>(
  rows: readonly T[],
  requestedWorkspaceId: string | undefined
): T | undefined {
  if (requestedWorkspaceId) {
    return rows.find(row => row.id === requestedWorkspaceId && row.slackClientId && row.slackClientSecret);
  }
  return rows.find(row => row.slackClientId && row.slackClientSecret);
}
