import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { DeviceFlowClient } from './DeviceFlowClient';

const BASE = { baseUrl: 'http://localhost:3000', clientId: 'b4m-cli' };

let sentBodies: Array<Record<string, unknown>>;
const previousAdapter = axios.defaults.adapter;

/**
 * Instances created by `axios.create()` inherit `axios.defaults.adapter`, so stubbing it here
 * intercepts the client's requests without exposing its axios instance on the public surface.
 */
function respondWith(data: unknown): void {
  axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
    sentBodies.push(JSON.parse(String(config.data)) as Record<string, unknown>);
    return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse);
  }) as AxiosAdapter;
}

beforeEach(() => {
  sentBodies = [];
});

afterEach(() => {
  axios.defaults.adapter = previousAdapter;
});

describe('DeviceFlowClient client_id', () => {
  it('sends the configured client_id on every grant request', async () => {
    respondWith({
      device_code: 'dc',
      user_code: 'uc',
      verification_uri: 'https://example.com/device',
      verification_uri_complete: 'https://example.com/device?code=uc',
      expires_in: 600,
      interval: 5,
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
    });
    const client = new DeviceFlowClient({ ...BASE, clientId: 'b4m-desktop' });

    await client.initiateDeviceFlow();
    await client.pollForToken('dc');
    await client.refreshToken('rt');

    expect(sentBodies.map(b => b.client_id)).toEqual(['b4m-desktop', 'b4m-desktop', 'b4m-desktop']);
  });
});

describe('DeviceFlowClient.pollForToken', () => {
  it('surfaces an OAuth error payload as an Error carrying the error code', async () => {
    respondWith({ error: 'authorization_pending', error_description: 'pending' });

    await expect(new DeviceFlowClient(BASE).pollForToken('dc')).rejects.toThrow('authorization_pending');
  });
});

describe('DeviceFlowClient.waitForAuthorization', () => {
  it('translates a terminal access_denied into a human-readable error', async () => {
    respondWith({ error: 'access_denied', error_description: 'denied' });

    await expect(new DeviceFlowClient(BASE).waitForAuthorization('dc', 0)).rejects.toThrow(
      'User denied the authorization request'
    );
  });

  it('translates a terminal expired_token into a human-readable error', async () => {
    respondWith({ error: 'expired_token', error_description: 'expired' });

    await expect(new DeviceFlowClient(BASE).waitForAuthorization('dc', 0)).rejects.toThrow(
      'Authorization code has expired'
    );
  });

  it('returns the token once the user approves', async () => {
    respondWith({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 });

    await expect(new DeviceFlowClient(BASE).waitForAuthorization('dc', 0)).resolves.toMatchObject({
      access_token: 'at',
    });
  });
});
