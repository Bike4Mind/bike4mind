import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessHostAuth } from './HeadlessHostAuth';

// One DeviceFlowClient serves initiate, token polling and refresh, and sends its configured id on
// all three (b4m-core/client-auth/src/DeviceFlowClient.test.ts). So the id it is constructed with
// is the id the host signs in and refreshes under.
const constructed = vi.hoisted(() => [] as { baseUrl: string; clientId: string }[]);
vi.mock('@bike4mind/client-auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/client-auth')>();
  class RecordingDeviceFlowClient {
    constructor(options: { baseUrl: string; clientId: string }) {
      constructed.push(options);
    }
    initiateDeviceFlow(): Promise<never> {
      return Promise.reject(new Error('recording client'));
    }
  }
  return { ...actual, DeviceFlowClient: RecordingDeviceFlowClient };
});

const silent = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  constructed.length = 0;
});

describe('headless host client id', () => {
  it('signs in and refreshes under its own client id, not the Desktop one', async () => {
    const dataDirectory = join(await mkdtemp(join(tmpdir(), 'host-client-id-')), 'host');
    const auth = createHeadlessHostAuth({
      dataDirectory,
      logger: silent,
      userAgent: 'b4m-host/test',
      defaultApiUrl: 'https://b4m.example.com',
    });
    try {
      await auth.initialize();
      // The recording client has no flow, so sign-in fails after construction.
      await auth.startSignIn().catch(() => undefined);
    } finally {
      auth.dispose();
    }

    expect(constructed.length).toBeGreaterThan(0);
    expect(constructed.every(options => options.clientId === 'b4m-host')).toBe(true);
  });
});
