import type { IOrgSlackWorkspaceDocument, ISlackDevWorkspaceDocument } from '@bike4mind/common';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';

export type SlackInstallation =
  | {
      kind: 'dev';
      signingSecret: string | undefined;
      botToken: string;
      workspace: ISlackDevWorkspaceDocument;
      workspaceWithCreds: ISlackDevWorkspaceDocument;
    }
  | {
      kind: 'org';
      signingSecret: string | undefined;
      botToken: string;
      orgWorkspace: IOrgSlackWorkspaceDocument & { id: string };
      appWorkspace: ISlackDevWorkspaceDocument;
    };

export type SlackInstallationResult =
  | { ok: true; installation: SlackInstallation }
  | { ok: false; reason: 'missing_ids' | 'not_found' | 'credentials_missing' | 'bot_token_missing' };

/**
 * Resolve the signing secret and bot token for a Slack request from its `api_app_id` and
 * `team_id`. Both ids must belong to the same installation: a dev workspace row for that exact
 * (app, team) pair, or an org workspace for that team that was installed through that app.
 * Shared by the events and interactive routes so the two cannot pick credentials differently.
 */
export async function resolveSlackInstallation(
  apiAppId: string | undefined,
  teamId: string | undefined
): Promise<SlackInstallationResult> {
  if (!apiAppId || !teamId) return { ok: false, reason: 'missing_ids' };

  const workspace = await slackDevWorkspaceRepository.findBySlackAppIdAndTeamId(apiAppId, teamId);
  if (workspace) {
    const withCreds = await slackDevWorkspaceRepository.findByIdWithCredentials(workspace.id);
    if (!withCreds) return { ok: false, reason: 'credentials_missing' };
    return {
      ok: true,
      installation: {
        kind: 'dev',
        signingSecret: withCreds.slackOAuthSigningSecret,
        botToken: decryptToken(withCreds.slackBotToken) ?? '',
        workspace,
        workspaceWithCreds: withCreds,
      },
    };
  }

  const orgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
  if (!orgWorkspace || orgWorkspace.slackAppId !== apiAppId) return { ok: false, reason: 'not_found' };
  if (!orgWorkspace.slackBotToken) return { ok: false, reason: 'bot_token_missing' };

  const appWorkspace = await slackDevWorkspaceRepository.findBySlackAppId(apiAppId);
  if (!appWorkspace) return { ok: false, reason: 'not_found' };

  return {
    ok: true,
    installation: {
      kind: 'org',
      signingSecret: appWorkspace.slackOAuthSigningSecret,
      botToken: decryptToken(orgWorkspace.slackBotToken) ?? '',
      orgWorkspace,
      appWorkspace,
    },
  };
}
