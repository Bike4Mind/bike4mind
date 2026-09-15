import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import {
  AuthSessionCreatedVia,
  IAuthSessionDevice,
  IAuthSessionDocument,
  IAuthSessionRepository,
} from '@bike4mind/common';
import { DEFAULT_REFRESH_TTL_MS } from './constants';
import { buildRefreshToken, generateRefreshSecret, hashRefreshSecret } from './refreshTokenFormat';

export interface IssueSessionParams {
  createdVia: AuthSessionCreatedVia;
  /** User's current tokenVersion, embedded in the minted access token. */
  tokenVersion: number;
  impersonatedBy?: string | null;
  device?: IAuthSessionDevice;
  /** Override the session/refresh lifetime; defaults to DEFAULT_REFRESH_TTL_MS. */
  refreshTtlMs?: number;
}

export interface IssueSessionAdapters {
  db: { authSessions: Pick<IAuthSessionRepository, 'create'> };
  /** Mints the access JWT; injected (AuthTokenGeneratorService.signAccessToken) to keep this
   *  service decoupled from the JWT layer and trivially mockable in tests. */
  signAccessToken: (id: string, tokenVersion: number, additionalPayload?: Record<string, unknown>) => string;
  logger?: Logger;
}

export interface IssuedSession {
  sid: string;
  accessToken: string;
  /** Opaque `<sid>.<secret>` refresh token. Only its hash is persisted. */
  refreshToken: string;
}

/**
 * Create a new authenticated session for a user: persist an AuthSession row (storing only the hash
 * of a fresh random refresh secret) and return a matching access JWT + opaque refresh token. Every
 * login path funnels through here so there is exactly one place that mints a session.
 */
export const issueSession = async (
  userId: string,
  params: IssueSessionParams,
  { db, signAccessToken, logger }: IssueSessionAdapters
): Promise<IssuedSession> => {
  const sid = randomUUID();
  const secret = generateRefreshSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS));

  await db.authSessions.create({
    sid,
    userId,
    refreshTokenHash: hashRefreshSecret(secret),
    previousRefreshTokenHash: null,
    graceExpiresAt: null,
    device: params.device,
    createdVia: params.createdVia,
    impersonatedBy: params.impersonatedBy ?? null,
    lastUsedAt: now,
    expiresAt,
    revokedAt: null,
  } as Omit<IAuthSessionDocument, 'id' | 'createdAt' | 'updatedAt'>);

  const accessToken = signAccessToken(userId, params.tokenVersion, {
    sid,
    ...(params.impersonatedBy ? { impersonatedBy: params.impersonatedBy } : {}),
  });

  logger?.log('Issued auth session', sid, 'for user', userId, 'via', params.createdVia);

  return { sid, accessToken, refreshToken: buildRefreshToken(sid, secret) };
};
