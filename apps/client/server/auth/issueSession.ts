import { AuthSessionCreatedVia, IAuthSessionDevice } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import type { Response } from 'express';
import { authTokenGenerator } from './tokenGenerator';
import { buildSessionDevice } from './sessionDevice';
import { setRefreshCookie } from './refreshCookie';

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
  logger?: Logger;
}

/**
 * Server-side convenience wrapper over authSessionService.issueSession: binds the AuthSession
 * repository, the JWT access-token signer, request-derived device metadata, and the request
 * logger, so each login/mint endpoint is a one-liner. Returns the access JWT + opaque refresh
 * token (and the sid, if a caller needs it, e.g. to keep the current device on a revoke-others).
 */
export async function issueSessionForRequest(
  req: RequestLike,
  userId: string,
  params: {
    createdVia: AuthSessionCreatedVia;
    tokenVersion: number;
    impersonatedBy?: string | null;
    device?: IAuthSessionDevice;
  }
): Promise<{ accessToken: string; refreshToken: string; sid: string }> {
  return authSessionService.issueSession(
    userId,
    {
      createdVia: params.createdVia,
      tokenVersion: params.tokenVersion,
      impersonatedBy: params.impersonatedBy,
      device: params.device ?? buildSessionDevice(req),
    },
    {
      db: { authSessions: authSessionRepository },
      signAccessToken: (id, tv, extra) => authTokenGenerator.signAccessToken(id, tv, extra),
      logger: req.logger,
    }
  );
}

/**
 * Browser login path: mint a session and hand the refresh token back as an HttpOnly cookie
 * rather than in the JSON body, so it is never readable by page scripts. Returns only the
 * access token, which the client keeps in memory (useAccessToken).
 *
 * Every browser mint site should use this instead of issueSessionForRequest. The CLI/OAuth
 * mint sites (pages/api/oauth/*) deliberately do NOT - they have no cookie jar and must keep
 * receiving the refresh token in the response body.
 */
export async function issueBrowserSession(
  req: RequestLike,
  res: Response,
  userId: string,
  params: Parameters<typeof issueSessionForRequest>[2]
): Promise<{ accessToken: string; sid: string }> {
  const { accessToken, refreshToken, sid } = await issueSessionForRequest(req, userId, params);
  setRefreshCookie(res, refreshToken);
  return { accessToken, sid };
}
