import { AtlassianTokenManager } from '@bike4mind/server-utils/integrations/jira/atlassianTokenManager';

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export interface JiraEventAccessParams {
  subscriberUserId: string;
  config: { atlassianCloudId: string; createdBy: string };
  payload: Record<string, unknown>;
}

function issueKeyOf(payload: Record<string, unknown>): string | undefined {
  const key = (payload.issue as { key?: unknown } | undefined)?.key;
  return typeof key === 'string' && ISSUE_KEY_PATTERN.test(key) ? key : undefined;
}

function sprintBoardIdOf(payload: Record<string, unknown>): number | undefined {
  const boardId = (payload.sprint as { originBoardId?: unknown } | undefined)?.originBoardId;
  return typeof boardId === 'number' && Number.isInteger(boardId) && boardId > 0 ? boardId : undefined;
}

async function canRead(url: string, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a subscriber may receive this Jira event: they must still be connected to the
 * config's Atlassian site and, with their own token, be able to read the event's issue
 * (issue and comment events) or board (sprint events). Events scoped to neither go only
 * to the config's creator. Fails closed on any lookup error.
 */
export async function canSubscriberViewJiraEvent({
  subscriberUserId,
  config,
  payload,
}: JiraEventAccessParams): Promise<boolean> {
  let tokens: Awaited<ReturnType<typeof AtlassianTokenManager.getValidTokens>>;
  try {
    tokens = await AtlassianTokenManager.getValidTokens(subscriberUserId);
  } catch {
    return false;
  }
  if (!tokens || tokens.cloudId !== config.atlassianCloudId) return false;

  const apiBase = `https://api.atlassian.com/ex/jira/${encodeURIComponent(tokens.cloudId)}`;

  const issueKey = issueKeyOf(payload);
  if (issueKey) {
    return canRead(`${apiBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=project`, tokens.accessToken);
  }

  const boardId = sprintBoardIdOf(payload);
  if (boardId) {
    return canRead(`${apiBase}/rest/agile/1.0/board/${boardId}`, tokens.accessToken);
  }

  return subscriberUserId === config.createdBy;
}
