import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const h = vi.hoisted(() => ({
  connect: vi.fn(),
  responses: new Map<string, { status: number; body: string }>(),
  // Replaces the canned response for a path; the stream is left for the test to drive.
  streamHooks: new Map<string, (stream: EventEmitter & { setTimeout: Mock; close: Mock }) => void>(),
}));

vi.mock('node:http2', () => {
  const constants = { NGHTTP2_CANCEL: 8 };
  return { default: { connect: h.connect, constants }, connect: h.connect, constants };
});

import {
  APNS_HOSTS,
  apnsSigningKeyError,
  createHttp2ApnsTransport,
  createProviderToken,
  readApnsConfig,
} from './sendPush.apns';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CONFIG = { keyId: 'KEYID12345', teamId: 'TEAMID1234', key: KEY_PEM, topic: 'com.example.client' };

/** A fake HTTP/2 session whose streams answer from h.responses, keyed by `host path`. */
function fakeSession(host: string) {
  const session = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    requests: [] as Array<{ headers: Record<string, string>; body: string }>,
    close: vi.fn(() => {
      session.closed = true;
    }),
    request: (headers: Record<string, string>) => {
      const stream = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(),
        setEncoding: vi.fn(),
        close: vi.fn(),
        end: (body: string) => {
          session.requests.push({ headers, body });
          const hook = h.streamHooks.get(headers[':path']);
          if (hook) {
            hook(stream);
            return;
          }
          const response = h.responses.get(`${host} ${headers[':path']}`) ?? { status: 200, body: '' };
          queueMicrotask(() => {
            stream.emit('response', { ':status': response.status });
            if (response.body) stream.emit('data', response.body);
            stream.emit('close');
          });
        },
      });
      return stream;
    },
  });
  return session;
}

describe('readApnsConfig', () => {
  const FULL = { APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_KEY: 'p', APNS_TOPIC: 'x' };

  it('is null unless all four values are set', () => {
    expect(readApnsConfig({}, {})).toBeNull();
    expect(readApnsConfig({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_KEY: 'p' }, {})).toBeNull();
    expect(readApnsConfig({ ...FULL, APNS_KEY: ' ' }, {})).toBeNull();
  });

  it("treats the secrets' 'not-configured' placeholder as unset", () => {
    expect(readApnsConfig({ ...FULL, APNS_TOPIC: 'not-configured' }, {})).toBeNull();
    expect(
      readApnsConfig(
        {
          APNS_KEY_ID: 'not-configured',
          APNS_TEAM_ID: 'not-configured',
          APNS_KEY: 'not-configured',
          APNS_TOPIC: 'not-configured',
        },
        {}
      )
    ).toBeNull();
  });

  it('prefers the linked secret and falls back to plain env per value (self-host)', () => {
    expect(readApnsConfig({}, FULL)).toEqual({ keyId: 'k', teamId: 't', key: 'p', topic: 'x' });
    expect(readApnsConfig({ ...FULL, APNS_TOPIC: 'not-configured' }, { APNS_TOPIC: 'env.topic' })?.topic).toBe(
      'env.topic'
    );
    expect(readApnsConfig({ ...FULL, APNS_TOPIC: 'secret.topic' }, { APNS_TOPIC: 'env.topic' })?.topic).toBe(
      'secret.topic'
    );
  });

  it('restores newlines in a single-line PEM', () => {
    const config = readApnsConfig(
      {
        APNS_KEY_ID: 'k',
        APNS_TEAM_ID: 't',
        APNS_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        APNS_TOPIC: 'com.example.client',
      },
      {}
    );
    expect(config?.key).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  });
});

describe('apnsSigningKeyError', () => {
  it('accepts a PKCS#8 P-256 key', () => {
    expect(apnsSigningKeyError(KEY_PEM)).toBeNull();
  });

  it('reports a malformed PEM or a non-EC key instead of throwing', () => {
    expect(apnsSigningKeyError('-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----')).toEqual(
      expect.any(String)
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(apnsSigningKeyError(rsa.toString())).toMatch(/expected an EC/);
  });
});

describe('createProviderToken', () => {
  it('produces an ES256 JWT that verifies against the signing key', () => {
    const token = createProviderToken(CONFIG, 1_700_000_000);
    const [header, claims, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAMID1234', iat: 1_700_000_000 });
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    );
    expect(valid).toBe(true);
  });
});

describe('createHttp2ApnsTransport', () => {
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();

  beforeEach(() => {
    sessions.clear();
    h.responses.clear();
    h.streamHooks.clear();
    h.connect.mockReset().mockImplementation((host: string) => {
      const session = fakeSession(host);
      sessions.set(host, session);
      return session;
    });
  });

  it("sends each token to its own environment's gateway, with bearer auth and the apns headers", async () => {
    const transport = createHttp2ApnsTransport(CONFIG);
    const headers = { 'apns-topic': 'com.example.client', 'apns-collapse-id': 'c1' };

    await transport.send({ environment: 'sandbox', deviceToken: 'dev-token', headers, payload: '{"a":1}' });
    await transport.send({ environment: 'production', deviceToken: 'prod-token', headers, payload: '{"a":2}' });

    expect(h.connect.mock.calls.map(([host]) => host)).toEqual([APNS_HOSTS.sandbox, APNS_HOSTS.production]);
    expect(APNS_HOSTS).toEqual({
      sandbox: 'https://api.sandbox.push.apple.com',
      production: 'https://api.push.apple.com',
    });
    const [sandboxRequest] = sessions.get(APNS_HOSTS.sandbox)!.requests;
    expect(sandboxRequest.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/dev-token',
      'apns-topic': 'com.example.client',
      'apns-collapse-id': 'c1',
    });
    expect(sandboxRequest.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sandboxRequest.body).toBe('{"a":1}');
    expect(sessions.get(APNS_HOSTS.production)!.requests[0].headers[':path']).toBe('/3/device/prod-token');
  });

  it('reuses one session per gateway and closes them all', async () => {
    const transport = createHttp2ApnsTransport(CONFIG);
    const request = { environment: 'production' as const, headers: {}, payload: '{}' };
    await transport.send({ ...request, deviceToken: 'a' });
    await transport.send({ ...request, deviceToken: 'b' });

    expect(h.connect).toHaveBeenCalledTimes(1);
    transport.close();
    expect(sessions.get(APNS_HOSTS.production)!.close).toHaveBeenCalled();
  });

  it('opens a new session once the held one has been idle past the window', async () => {
    let nowMs = Date.UTC(2029, 0, 1);
    const transport = createHttp2ApnsTransport(CONFIG, () => nowMs);
    const request = { environment: 'production' as const, headers: {}, payload: '{}' };
    await transport.send({ ...request, deviceToken: 'a' });
    const first = sessions.get(APNS_HOSTS.production)!;

    nowMs += 3 * 60_000;
    await transport.send({ ...request, deviceToken: 'b' });
    expect(h.connect).toHaveBeenCalledTimes(1);

    nowMs += 4 * 60_000 + 1;
    await transport.send({ ...request, deviceToken: 'c' });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
  });

  it('opens a new session after the held one emits close', async () => {
    const transport = createHttp2ApnsTransport(CONFIG);
    const request = { environment: 'production' as const, headers: {}, payload: '{}' };
    await transport.send({ ...request, deviceToken: 'a' });
    sessions.get(APNS_HOSTS.production)!.emit('close');
    await transport.send({ ...request, deviceToken: 'b' });
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it('reuses the provider token until 45 minutes and signs a fresh one after', async () => {
    // Far from Date.now() so a token cached by an earlier test cannot match.
    let nowMs = Date.UTC(2030, 0, 1);
    const transport = createHttp2ApnsTransport(CONFIG, () => nowMs);
    const authorizationAt = async (atMs: number) => {
      nowMs = atMs;
      await transport.send({ environment: 'production', deviceToken: 'tok', headers: {}, payload: '{}' });
      const { requests } = sessions.get(APNS_HOSTS.production)!;
      return requests[requests.length - 1].headers.authorization;
    };
    const start = nowMs;

    const first = await authorizationAt(start);
    expect(await authorizationAt(start + 44 * 60_000 + 59_000)).toBe(first);
    const refreshed = await authorizationAt(start + 45 * 60_000 + 1_000);
    expect(refreshed).not.toBe(first);
    expect(await authorizationAt(start + 45 * 60_000 + 2_000)).toBe(refreshed);
  });

  it('signs a fresh provider token when APNS_KEY rotates under the same key id', async () => {
    const nowMs = Date.UTC(2031, 0, 1);
    const authorization = async (config: typeof CONFIG) => {
      const transport = createHttp2ApnsTransport(config, () => nowMs);
      await transport.send({ environment: 'production', deviceToken: 'tok', headers: {}, payload: '{}' });
      const { requests } = sessions.get(APNS_HOSTS.production)!;
      return requests[requests.length - 1].headers.authorization;
    };
    const rotatedKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();

    const first = await authorization(CONFIG);
    expect(await authorization(CONFIG)).toBe(first);
    expect(await authorization({ ...CONFIG, key: rotatedKey })).not.toBe(first);
  });

  it("returns APNs' status and reason", async () => {
    h.responses.set(`${APNS_HOSTS.production} /3/device/gone`, { status: 410, body: '{"reason":"Unregistered"}' });
    const transport = createHttp2ApnsTransport(CONFIG);

    await expect(
      transport.send({ environment: 'production', deviceToken: 'gone', headers: {}, payload: '{}' })
    ).resolves.toEqual({ status: 410, reason: 'Unregistered' });
  });

  describe('failure paths', () => {
    const request = { environment: 'production' as const, deviceToken: 'tok', headers: {}, payload: '{}' };
    const hookStream = (hook: Parameters<typeof h.streamHooks.set>[1]) => h.streamHooks.set('/3/device/tok', hook);

    it('rejects with the error a stream emits', async () => {
      const failure = new Error('stream reset');
      hookStream(stream => queueMicrotask(() => stream.emit('error', failure)));

      await expect(createHttp2ApnsTransport(CONFIG).send(request)).rejects.toBe(failure);
    });

    it('cancels the stream on timeout and rejects once it closes without a response', async () => {
      let captured: Parameters<Parameters<typeof h.streamHooks.set>[1]>[0] | undefined;
      hookStream(stream => {
        captured = stream;
      });
      const sent = createHttp2ApnsTransport(CONFIG).send(request);
      const settled = expect(sent).rejects.toThrow('APNs stream closed without a response');
      await Promise.resolve();

      const [timeoutMs, onTimeout] = captured!.setTimeout.mock.calls[0];
      expect(timeoutMs).toBe(10_000);
      onTimeout();
      expect(captured!.close).toHaveBeenCalledWith(8);
      captured!.emit('close');
      await settled;
    });

    it('rejects when a stream closes with no response', async () => {
      hookStream(stream => queueMicrotask(() => stream.emit('close')));

      await expect(createHttp2ApnsTransport(CONFIG).send(request)).rejects.toThrow(
        'APNs stream closed without a response'
      );
    });

    it('survives a session error mid-flight, fails the stream, and opens a new session next', async () => {
      const transport = createHttp2ApnsTransport(CONFIG);
      const streamFailure = new Error('ECONNRESET');
      hookStream(stream => {
        queueMicrotask(() => {
          sessions.get(APNS_HOSTS.production)!.emit('error', new Error('session broke'));
          stream.emit('error', streamFailure);
        });
      });

      await expect(transport.send(request)).rejects.toBe(streamFailure);

      h.streamHooks.clear();
      await expect(transport.send(request)).resolves.toEqual({ status: 200, reason: undefined });
      expect(h.connect).toHaveBeenCalledTimes(2);
    });
  });
});
