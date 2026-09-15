import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { NextApiRequest, NextApiResponse } from 'next';
import { Logger } from '@bike4mind/observability';
import { createInstallProvider } from '@bike4mind/slack';
import type { InstallationMetadata } from '@bike4mind/slack';
import { CallbackOptions } from '@slack/oauth';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { randomUUID } from 'crypto';

/**
 * Slack OAuth Callback Endpoint
 *
 * NOTE: This intentionally does NOT use baseApi() with JWT auth. OAuth callbacks
 * are browser redirects from Slack - there is no opportunity to attach a Bearer
 * token. The request is protected by the OAuth state parameter (CSRF token)
 * instead. Same pattern as auth/github/mcp-callback.ts.
 *
 * Handles OAuth callback from Slack with:
 * - CSRF validation (state parameter)
 * - Token exchange
 * - Workspace storage (via installationStore)
 *
 * GET /api/slack/oauth/callback?code=xxx&state=yyy
 * Redirects to: /integrations/slack/success or /integrations/slack/error
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'oauth',
      integrationName: 'slack',
      action: 'oauth_callback',
      requestId: randomUUID().split('-')[0],
    },
    req
  );

  Logger.info('🔄 Slack OAuth callback received', {
    hasCode: !!req.query.code,
    hasState: !!req.query.state,
    hasError: !!req.query.error,
  });

  // Track OAuth error outside try block for proper type inference
  let oauthErrorMessage = '';
  let oauthErrorCode = '';

  try {
    // Track installation metadata for success redirect
    let metadata: InstallationMetadata = { isReinstall: false, teamName: 'your workspace', teamId: '' };

    const installer = await createInstallProvider((installMetadata: InstallationMetadata) => {
      metadata = installMetadata;
    });

    const callbackOptions: CallbackOptions = {
      success: async (installation, _installOptions, _req, _res) => {
        Logger.info('✅ Slack OAuth success', {
          teamId: installation.team?.id,
          teamName: metadata.teamName,
          isReinstall: metadata.isReinstall,
          botUserId: installation.bot?.userId,
        });
        auditLogger.setWorkspaceId(installation.team?.id || '');
        auditLogger.success({
          teamId: installation.team?.id,
          teamName: metadata.teamName,
          isReinstall: metadata.isReinstall,
        });
      },
      failure: (error, _installOptions, _req, _res) => {
        const errorCode = 'code' in error && typeof error.code === 'string' ? error.code : '';
        Logger.error('❌ Slack OAuth failure', {
          error: error.message,
          code: errorCode,
        });
        // Track the error so we can redirect to error page
        oauthErrorMessage = error.message;
        oauthErrorCode = errorCode;
        auditLogger.failure(oauthErrorCode || 'oauth_failure');
      },
    };

    // handleCallback validates state, exchanges code for token, and calls installationStore
    await installer.handleCallback(req, res, callbackOptions);

    // If failure callback was called, redirect to error page
    if (oauthErrorMessage && !res.writableEnded) {
      let reason = 'server_error';

      if (oauthErrorMessage.includes('cancelled') || oauthErrorCode === 'slack_oauth_installer_authorization_error') {
        reason = 'access_denied';
      } else if (oauthErrorMessage.includes('state')) {
        reason = 'invalid_params';
      } else if (oauthErrorMessage.includes('invalid_code') || oauthErrorMessage.includes('code')) {
        reason = 'invalid_code';
      }

      const redirectUrl = `/integrations/slack/error?reason=${reason}`;
      Logger.info('🚨 Redirecting to error page', {
        reason,
        errorMessage: oauthErrorMessage,
        redirectUrl,
      });

      return res.redirect(redirectUrl);
    }

    // If we get here and res hasn't been sent, redirect to success
    if (!res.writableEnded) {
      const params = new URLSearchParams();
      params.set('workspace', metadata.teamName);
      if (metadata.teamId) {
        params.set('teamId', metadata.teamId);
      }
      if (metadata.isReinstall) {
        params.set('reinstall', 'true');
      }

      const redirectUrl = `/integrations/slack/success?${params.toString()}`;
      Logger.info('🎯 Redirecting to success page', {
        teamId: metadata.teamId,
        teamName: metadata.teamName,
        isReinstall: metadata.isReinstall,
        redirectUrl,
      });

      return res.redirect(redirectUrl);
    }
  } catch (error: unknown) {
    const err = error as Error;
    Logger.error('❌ Slack OAuth callback error', {
      error: err.message,
      stack: err.stack,
    });
    auditLogger.failure('callback_error');

    // Map error to user-friendly reason
    let reason = 'server_error';

    if (err.message?.includes('state')) {
      reason = 'invalid_params';
    } else if (err.message?.includes('access_denied') || err.message?.includes('cancelled')) {
      reason = 'access_denied';
    } else if (err.message?.includes('invalid_code') || err.message?.includes('code')) {
      reason = 'invalid_code';
    }

    if (!res.writableEnded) {
      const redirectUrl = `/integrations/slack/error?reason=${reason}`;
      Logger.info('🚨 Redirecting to error page', {
        reason,
        errorMessage: err.message,
        redirectUrl,
      });

      return res.redirect(redirectUrl);
    }
  }
}
