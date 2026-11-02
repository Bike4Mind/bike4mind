import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { PushTokenEnvironment } from '@bike4mind/database';

/**
 * Minimal APNs provider client: HTTP/2 to Apple's gateway with token (.p8) auth. Built on node:http2 and
 * node:crypto rather than a push library so the Lambda carries no extra dependency and no native module;
 * the whole protocol surface used here is one POST per device token.
 */

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM of the .p8 signing key. */
  key: string;
  /** The client's bundle id, sent as apns-topic. */
  topic: string;
};

export const APNS_HOSTS: Record<PushTokenEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/**
 * Null unless all four APNS_* values are set: an unconfigured deployment (preview, self-host) no-ops.
 * APNS_KEY may arrive with literal `\n` escapes when set through a single-line env value.
 */
export function readApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const key = env.APNS_KEY?.trim().replace(/\\n/g, '\n');
  const topic = env.APNS_TOPIC?.trim();
  if (!keyId || !teamId || !key || !topic) return null;
  return { keyId, teamId, key, topic };
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** ES256 provider token. APNs wants the raw r||s signature (IEEE P1363), not DER. */
export function createProviderToken(
  config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'key'>,
  issuedAtSeconds: number
): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(config.key),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

// APNs rejects a token older than 60 minutes and throttles one refreshed more often than every 20.
const TOKEN_TTL_MS = 45 * 60_000;
let cachedToken: { cacheKey: string; token: string; issuedAtMs: number } | undefined;

function providerToken(config: ApnsConfig, nowMs: number): string {
  const cacheKey = `${config.teamId}:${config.keyId}`;
  if (cachedToken && cachedToken.cacheKey === cacheKey && nowMs - cachedToken.issuedAtMs < TOKEN_TTL_MS) {
    return cachedToken.token;
  }
  const token = createProviderToken(config, Math.floor(nowMs / 1000));
  cachedToken = { cacheKey, token, issuedAtMs: nowMs };
  return token;
}

export type ApnsRequest = {
  environment: PushTokenEnvironment;
  deviceToken: string;
  /** apns-* headers; authorization and the pseudo-headers are added by the transport. */
  headers: Record<string, string>;
  payload: string;
};

/** `reason` is APNs' error string (e.g. `Unregistered`, `BadDeviceToken`) on a non-200. */
export type ApnsResponse = { status: number; reason?: string };

export type ApnsTransport = {
  send(request: ApnsRequest): Promise<ApnsResponse>;
  close(): void;
};

const REQUEST_TIMEOUT_MS = 10_000;

/** One HTTP/2 session per gateway host, opened on first use and held until close(). */
export function createHttp2ApnsTransport(config: ApnsConfig, now: () => number = Date.now): ApnsTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();

  const sessionFor = (host: string) => {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(host);
    // A session-level error also fails each in-flight stream, which is where it is reported.
    session.on('error', () => sessions.delete(host));
    sessions.set(host, session);
    return session;
  };

  return {
    send: request =>
      new Promise<ApnsResponse>((resolve, reject) => {
        const stream = sessionFor(APNS_HOSTS[request.environment]).request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(request.deviceToken)}`,
          authorization: `bearer ${providerToken(config, now())}`,
          'content-type': 'application/json',
          ...request.headers,
        });
        stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL));

        let status = 0;
        let body = '';
        stream.setEncoding('utf8');
        stream.on('response', headers => {
          status = Number(headers[':status'] ?? 0);
        });
        stream.on('data', (chunk: string) => {
          body += chunk;
        });
        stream.on('error', reject);
        stream.on('close', () => {
          if (status === 0) {
            reject(new Error('APNs stream closed without a response'));
            return;
          }
          resolve({ status, reason: parseReason(body) });
        });
        stream.end(request.payload);
      }),
    close: () => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}

function parseReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'reason' in parsed && typeof parsed.reason === 'string') {
      return parsed.reason;
    }
  } catch {
    // A non-JSON body carries no reason APNs documents; the status alone is reported.
  }
  return undefined;
}
