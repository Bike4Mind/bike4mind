import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OAuthDeviceClientId } from '@bike4mind/common';
import { AuthService } from './AuthService';
import { TokenVault, type VaultFile } from './tokenVault';
import type { SecretCipher } from '../../host/ports';

// One DeviceFlowClient serves initiate, token polling and refresh and sends its configured id on
// all three (b4m-core/client-auth/src/DeviceFlowClient.test.ts), so the id it is constructed
// with is the id the service signs in and refreshes under.
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

const BAKED = 'B4M_DEFAULT_API_URL';

afterEach(() => {
  delete process.env[BAKED];
  constructed.length = 0;
});

const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};

function memoryFile(): VaultFile {
  let contents: string | null = null;
  return {
    async read() {
      return contents;
    },
    async write(next: string) {
      contents = next;
    },
  };
}

async function signInAttempt(clientId?: OAuthDeviceClientId): Promise<void> {
  process.env[BAKED] = 'https://b4m.example.com';
  const service = new AuthService({
    vault: new TokenVault(cipher, memoryFile(), silentLogger),
    logger: silentLogger,
    openExternal: async () => undefined,
    devFallback: false,
    userAgent: 'b4m-desktop/test',
    onStateChanged: () => undefined,
    clientId,
  });
  await service.initialize();
  await service.signIn();
  service.dispose();
}

describe('AuthService client id', () => {
  it('keeps Desktop on b4m-desktop by default', async () => {
    await signInAttempt();
    expect(constructed.length).toBeGreaterThan(0);
    expect(constructed.every(options => options.clientId === 'b4m-desktop')).toBe(true);
  });

  it('uses the id it is given', async () => {
    await signInAttempt('b4m-host');
    expect(constructed.length).toBeGreaterThan(0);
    expect(constructed.every(options => options.clientId === 'b4m-host')).toBe(true);
  });
});
