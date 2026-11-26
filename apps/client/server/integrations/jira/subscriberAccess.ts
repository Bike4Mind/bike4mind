import { AtlassianTokenManager } from '@bike4mind/server-utils/integrations/jira/atlassianTokenManager';

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PROJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface JiraEventAccessParams {
  subscriberUserId: string;
  config: { atlassianCloudId: string; createdBy: string };
  payload: Record<string, unknown>;
}

function issueKeyOf(payload: Record<string, unknown>): string | undefined {
  const key = (payload.issue as { key?: unknown } | undefined)?.key;
  return typeof key === 'string' && ISSUE_KEY_PATTERN.test(key) ? key : undefined;
}

function commentIdOf(payload: Record<string, unknown>): string | undefined {
  const id = (payload.comment as { id?: unknown } | undefined)?.id;
  const value = typeof id === 'number' ? String(id) : id;
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}

function projectKeyOf(payload: Record<string, unknown>): string | undefined {
  const issue = payload.issue as { fields?: { project?: { key?: unknown } } } | undefined;
  const key = issue?.fields?.project?.key ?? (payload.project as { key?: unknown } | undefined)?.key;
  return typeof key === 'string' && PROJECT_KEY_PATTERN.test(key) ? key : undefined;
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

async function canBrowseProject(apiBase: string, projectKey: string, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${apiBase}/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}&permissions=BROWSE_PROJECTS`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { permissions?: { BROWSE_PROJECTS?: { havePermission?: unknown } } };
    return body.permissions?.BROWSE_PROJECTS?.havePermission === true;
  } catch {
    return false;
  }
}

/**
 * Whether a subscriber may receive this Jira event: they must still be connected to the
 * config's Atlassian site and, with their own token, be able to read the event's issue,
 * browse its project (a deleted issue can no longer be read) or read its board (sprint
 * events). Events scoped to none of these go only to the config's creator. Fails closed
 * on any lookup error.
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
  if (issueKey && payload.webhookEvent !== 'jira:issue_deleted') {
    // A comment can carry its own role/group visibility; reading it also proves issue access.
    const commentId = payload.webhookEvent === 'comment_deleted' ? undefined : commentIdOf(payload);
    if (commentId) {
      return canRead(
        `${apiBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${commentId}`,
        tokens.accessToken
      );
    }
    return canRead(`${apiBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=project`, tokens.accessToken);
  }

  const projectKey = projectKeyOf(payload);
  if (projectKey) {
    return canBrowseProject(apiBase, projectKey, tokens.accessToken);
  }
  if (issueKey) return false;

  const boardId = sprintBoardIdOf(payload);
  if (boardId) {
    return canRead(`${apiBase}/rest/agile/1.0/board/${boardId}`, tokens.accessToken);
  }

  return subscriberUserId === config.createdBy;
}
