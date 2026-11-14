import { createPrivateKey, sign } from 'node:crypto';
import { readFcmConfig, type FcmConfigResult, type FcmCredentials } from '@bike4mind/server-utils/utils/pushDelivery';

/**
 * Minimal FCM HTTP v1 client for Android push. Like the APNs client it is built on node primitives
 * (fetch, node:crypto) so the Lambda carries no extra dependency: a service-account JWT is exchanged for
 * a short-lived OAuth access token, then each device gets one POST to messages:send.
 */

export type FcmConfig = FcmCredentials;

/** The resolved credentials, or why there are none; see readFcmConfig in server-utils pushDelivery. */
export const readFcmSenderConfig = (): FcmConfigResult => readFcmConfig();

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const fcmSendEndpoint = (projectId: string) =>
  `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

/**
 * The reason the service account private key cannot sign RS256 assertions, or null when it can. Checked
 * once per invocation so a malformed key is reported as configuration, not retried per device.
 */
export function fcmSigningKeyError(privateKey: string): string | null {
  try {
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== 'rsa') return `expected an RSA key, got ${parsed.asymmetricKeyType}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** RS256 JWT assertion Google exchanges for an access token (RFC 7523). */
export function createServiceAccountAssertion(
  config: Pick<FcmConfig, 'clientEmail' | 'privateKey'>,
  issuedAtSeconds: number
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: FCM_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey(config.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

/** The message body of messages:send's `message` field (`token` is added per device by the transport). */
export type FcmMessage = {
  notification: { title: string; body: string };
  /** Values must be strings: FCM rejects any other type in `data`. */
  data: Record<string, string>;
  android: {
    priority: 'HIGH' | 'NORMAL';
    /** Replaces an earlier undelivered message with the same key (the APNs collapse-id counterpart). */
    collapse_key: string;
    notification: { tag: string };
  };
};

export type FcmRequest = { deviceToken: string; message: FcmMessage };

/**
 * `status` is the HTTP status; `errorStatus` is FCM's canonical error (`UNREGISTERED`, `INVALID_ARGUMENT`,
 * `QUOTA_EXCEEDED`, ...) on a non-200. A failure to obtain the access token is reported the same way, with
 * `stage: 'auth'`, so credential rejections reach the sender's config-error handling.
 */
export type FcmResponse = { status: number; errorStatus?: string; errorDetail?: string; stage?: 'auth' | 'send' };

export type FcmTransport = {
  send(request: FcmRequest): Promise<FcmResponse>;
};

const REQUEST_TIMEOUT_MS = 10_000;
// Access tokens last an hour; refresh early so one never expires between the cache check and the request.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

type FetchFn = typeof fetch;

type CachedAccessToken = { token: string; expiresAtMs: number };

/** One access token is cached per transport and shared by every send until it nears expiry. */
export function createHttpFcmTransport(
  config: FcmConfig,
  now: () => number = Date.now,
  fetchFn: FetchFn = fetch
): FcmTransport {
  let cached: CachedAccessToken | undefined;

  const post = (url: string, init: { headers: Record<string, string>; body: string }) =>
    fetchFn(url, { method: 'POST', ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  /** A failed exchange is returned as an FcmResponse (auth stage) rather than thrown. */
  const accessToken = async (): Promise<{ token: string } | { failure: FcmResponse }> => {
    if (cached && cached.expiresAtMs - now() > ACCESS_TOKEN_REFRESH_MARGIN_MS) return { token: cached.token };
    const assertion = createServiceAccountAssertion(config, Math.floor(now() / 1000));
    const response = await post(TOKEN_ENDPOINT, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const body = await readJson(response);
    const token = typeof body?.access_token === 'string' ? body.access_token : undefined;
    if (!response.ok || !token) {
      return {
        failure: {
          status: response.status,
          errorStatus: typeof body?.error === 'string' ? body.error : undefined,
          errorDetail: typeof body?.error_description === 'string' ? body.error_description : undefined,
          stage: 'auth',
        },
      };
    }
    const expiresInSeconds = typeof body?.expires_in === 'number' ? body.expires_in : 3600;
    cached = { token, expiresAtMs: now() + expiresInSeconds * 1000 };
    return { token };
  };

  return {
    send: async request => {
      const auth = await accessToken();
      if ('failure' in auth) return auth.failure;
      const response = await post(fcmSendEndpoint(config.projectId), {
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: request.deviceToken, ...request.message } }),
      });
      if (response.ok) return { status: response.status, stage: 'send' };
      // A 401 means the cached token was revoked or expired early; drop it so the next send re-exchanges.
      if (response.status === 401) cached = undefined;
      const error = errorBody(await readJson(response));
      return { status: response.status, errorStatus: error.status, errorDetail: error.message, stage: 'send' };
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // A non-JSON body carries no error code; the HTTP status alone is reported.
    return undefined;
  }
}

function errorBody(body: Record<string, unknown> | undefined): { status?: string; message?: string } {
  const error = body?.error;
  if (typeof error !== 'object' || error === null) return {};
  const { status, message } = error as { status?: unknown; message?: unknown };
  return {
    status: typeof status === 'string' ? status : undefined,
    message: typeof message === 'string' ? message : undefined,
  };
}
