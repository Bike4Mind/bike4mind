import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHttpFcmTransport, createServiceAccountAssertion, fcmSigningKeyError } from './sendPush.fcm';
import { readFcmConfig } from '@bike4mind/server-utils/utils/pushDelivery';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CONFIG = {
  projectId: 'demo-project',
  clientEmail: 'push@demo-project.iam.gserviceaccount.com',
  privateKey: KEY_PEM,
};
const MESSAGE = {
  notification: { title: 'Reply ready', body: 'A new reply is ready.' },
  data: { category: 'chat_completed', deepLink: '/notebooks/s1' },
  android: { priority: 'HIGH' as const, collapse_key: 'c', notification: { tag: 'c' } },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const decodePart = (jwtPart: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwtPart, 'base64url').toString('utf8'));

describe('readFcmConfig', () => {
  const ACCOUNT = JSON.stringify({ project_id: 'p', client_email: 'e@x', private_key: 'k' });

  it('is unset for a missing, blank or placeholder value', () => {
    expect(readFcmConfig({}, {})).toEqual({ status: 'unset' });
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: ' ' }, {})).toEqual({ status: 'unset' });
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: 'not-configured' }, {})).toEqual({ status: 'unset' });
  });

  it('reads the linked secret first, then env', () => {
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: ACCOUNT }, {})).toEqual({
      status: 'ok',
      credentials: { projectId: 'p', clientEmail: 'e@x', privateKey: 'k' },
    });
    expect(readFcmConfig({}, { FCM_SERVICE_ACCOUNT: ACCOUNT }).status).toBe('ok');
  });

  it('reports malformed JSON and missing fields as invalid, naming no secret value', () => {
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: '{nope' }, {})).toEqual({
      status: 'invalid',
      error: 'FCM_SERVICE_ACCOUNT is not valid JSON',
    });
    const missing = readFcmConfig({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p' }) }, {});
    expect(missing).toMatchObject({ status: 'invalid', error: expect.stringContaining('client_email') });
  });
});

describe('fcmSigningKeyError', () => {
  it('accepts an RSA key and rejects garbage and non-RSA keys', () => {
    expect(fcmSigningKeyError(KEY_PEM)).toBeNull();
    expect(fcmSigningKeyError('not-a-key')).toEqual(expect.any(String));
    const ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(fcmSigningKeyError(ecPem)).toMatch(/RSA/);
  });
});

describe('createServiceAccountAssertion', () => {
  it('signs an RS256 JWT for the messaging scope that verifies with the public key', () => {
    const jwt = createServiceAccountAssertion(CONFIG, 1_800_000_000);
    const [header, claims, signature] = jwt.split('.');

    expect(decodePart(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodePart(claims)).toEqual({
      iss: CONFIG.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    expect(
      verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))
    ).toBe(true);
  });
});

describe('createHttpFcmTransport', () => {
  const tokenOk = () => json({ access_token: 'ya29.token', expires_in: 3600 });

  it('exchanges the assertion once, then posts messages:send with the bearer token and device token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async url =>
      String(url).includes('oauth2') ? tokenOk() : json({ name: 'projects/demo-project/messages/1' })
    );
    const transport = createHttpFcmTransport(CONFIG, () => 1_800_000_000_000, fetchFn);

    await expect(transport.send({ deviceToken: 'dev-1', message: MESSAGE })).resolves.toMatchObject({ status: 200 });
    await transport.send({ deviceToken: 'dev-2', message: MESSAGE });

    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls.filter(url => url.includes('oauth2'))).toHaveLength(1);
    const [, init] = fetchFn.mock.calls[1];
    expect(urls[1]).toBe('https://fcm.googleapis.com/v1/projects/demo-project/messages:send');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ya29.token');
    expect(JSON.parse(String(init?.body))).toEqual({ message: { token: 'dev-1', ...MESSAGE } });
    const exchangeBody = new URLSearchParams(String(fetchFn.mock.calls[0][1]?.body));
    expect(exchangeBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('refreshes the access token once it nears expiry', async () => {
    let nowMs = 1_800_000_000_000;
    const fetchFn = vi.fn<typeof fetch>(async url => (String(url).includes('oauth2') ? tokenOk() : json({})));
    const transport = createHttpFcmTransport(CONFIG, () => nowMs, fetchFn);

    await transport.send({ deviceToken: 'a', message: MESSAGE });
    nowMs += 56 * 60_000;
    await transport.send({ deviceToken: 'b', message: MESSAGE });

    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(2);
  });

  it('maps FCM error bodies to errorStatus and detail', async () => {
    const fetchFn = vi.fn<typeof fetch>(async url =>
      String(url).includes('oauth2')
        ? tokenOk()
        : json({ error: { code: 404, status: 'UNREGISTERED', message: 'Requested entity was not found.' } }, 404)
    );
    const transport = createHttpFcmTransport(CONFIG, Date.now, fetchFn);

    await expect(transport.send({ deviceToken: 'a', message: MESSAGE })).resolves.toEqual({
      status: 404,
      errorStatus: 'UNREGISTERED',
      errorDetail: 'Requested entity was not found.',
      stage: 'send',
    });
  });

  it('reports a rejected OAuth exchange as an auth-stage failure without sending the message', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)
    );
    const transport = createHttpFcmTransport(CONFIG, Date.now, fetchFn);

    await expect(transport.send({ deviceToken: 'a', message: MESSAGE })).resolves.toEqual({
      status: 400,
      errorStatus: 'invalid_grant',
      errorDetail: 'Invalid JWT Signature.',
      stage: 'auth',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('drops the cached token after a 401 so the next send re-exchanges', async () => {
    let sends = 0;
    const fetchFn = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('oauth2')) return tokenOk();
      return sends++ === 0 ? json({ error: { status: 'UNAUTHENTICATED' } }, 401) : json({});
    });
    const transport = createHttpFcmTransport(CONFIG, () => 1_800_000_000_000, fetchFn);

    await expect(transport.send({ deviceToken: 'a', message: MESSAGE })).resolves.toMatchObject({ status: 401 });
    await transport.send({ deviceToken: 'b', message: MESSAGE });

    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(2);
  });

  it('survives a non-JSON error body with just the status', async () => {
    const fetchFn = vi.fn<typeof fetch>(async url =>
      String(url).includes('oauth2') ? tokenOk() : new Response('<html>bad gateway</html>', { status: 502 })
    );
    const transport = createHttpFcmTransport(CONFIG, Date.now, fetchFn);

    await expect(transport.send({ deviceToken: 'a', message: MESSAGE })).resolves.toEqual({
      status: 502,
      errorStatus: undefined,
      errorDetail: undefined,
      stage: 'send',
    });
  });
});
