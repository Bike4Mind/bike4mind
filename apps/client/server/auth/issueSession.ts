import { AuthSessionCreatedVia, IAuthSessionDevice } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { authTokenGenerator } from './tokenGenerator';
import { buildSessionDevice } from './sessionDevice';

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
