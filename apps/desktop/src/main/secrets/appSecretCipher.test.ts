import { describe, expect, it, vi } from 'vitest';
import type { SecretCipher } from '../chat/mcp/McpServerStore';
import {
  AppSecretCipher,
  createAppSecretCipher,
  macBundlePath,
  selectSecretCipherMode,
  type AppSecretCipherHost,
} from './appSecretCipher';
import { fakeKeychain } from './fakeKeychain.testHelper';
import { resealed } from './reseal';
import type { RunResult } from './runProcess';
import { SecretKeyCipher } from './secretKeyCipher';

const EXEC = '/Applications/Bike4Mind.app/Contents/MacOS/Bike4Mind';
const KEY = Buffer.alloc(32, 3);

const signature = (team: string): RunResult => ({
  status: 0,
  stdout: '',
  stderr: `Executable=${EXEC}\nIdentifier=com.bike4mind.desktop\nAuthority=Some Authority\nTeamIdentifier=${team}\n`,
});

/** Reversible stand-in for safeStorage, whose blobs start with "v10" like the real one's. */
function fakeSafeStorage(extra: { getSelectedStorageBackend?: () => string } = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plain: string) => Buffer.from(`v10${plain}`, 'utf8')),
    decryptString: vi.fn((encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('v10')) throw new Error('not a safeStorage blob');
      return text.slice(3);
    }),
    ...extra,
  } satisfies SecretCipher & { getSelectedStorageBackend?: () => string };
}

function host(overrides: Partial<AppSecretCipherHost> = {}): AppSecretCipherHost {
  return {
    platform: 'darwin',
    isPackaged: true,
    execPath: EXEC,
    appName: 'Bike4Mind',
    safeStorage: fakeSafeStorage(),
    run: fakeKeychain({ codesign: signature('not set') }).run,
    warn: vi.fn(),
    ...overrides,
  };
}

describe('macBundlePath', () => {
  it('finds the .app bundle that holds the running executable', () => {
    expect(macBundlePath(EXEC)).toBe('/Applications/Bike4Mind.app');
    expect(macBundlePath('/usr/local/bin/electron')).toBeNull();
    expect(macBundlePath('/Applications/Bike4Mind/Contents/MacOS/Bike4Mind')).toBeNull();
  });
});

describe('selectSecretCipherMode', () => {
  it('uses the secret key for a packaged macOS build whose signature has no team identifier', () => {
    const keychain = fakeKeychain({ codesign: signature('not set') });

    expect(selectSecretCipherMode({ platform: 'darwin', isPackaged: true, execPath: EXEC, run: keychain.run })).toBe(
      'secret-key'
    );
    expect(keychain.calls).toEqual([
      { file: '/usr/bin/codesign', args: ['-dv', '--verbose=2', '/Applications/Bike4Mind.app'] },
    ]);
  });

  it('keeps safeStorage for a build signed with a team identifier', () => {
    const { run } = fakeKeychain({ codesign: signature('ABCDE12345') });

    expect(selectSecretCipherMode({ platform: 'darwin', isPackaged: true, execPath: EXEC, run })).toBe('safe-storage');
  });

  it('keeps safeStorage for an unpackaged run and off macOS, without running codesign', () => {
    for (const [platform, isPackaged] of [
      ['darwin', false],
      ['win32', true],
      ['linux', true],
    ] as const) {
      const keychain = fakeKeychain({ codesign: signature('not set') });
      expect(selectSecretCipherMode({ platform, isPackaged, execPath: EXEC, run: keychain.run })).toBe('safe-storage');
      expect(keychain.calls).toEqual([]);
    }
  });

  it('keeps safeStorage when the signature cannot be read or says nothing about a team', () => {
    const outcomes: RunResult[] = [
      { status: 1, stdout: '', stderr: 'code object is not signed at all\n' },
      { status: null, stdout: '', stderr: '' },
      { status: 0, stdout: '', stderr: 'Executable=x\nSignature=adhoc\n' },
    ];
    for (const codesign of outcomes) {
      const { run } = fakeKeychain({ codesign });
      expect(selectSecretCipherMode({ platform: 'darwin', isPackaged: true, execPath: EXEC, run })).toBe(
        'safe-storage'
      );
    }
    const odd = fakeKeychain({ codesign: signature('not set') });
    expect(
      selectSecretCipherMode({ platform: 'darwin', isPackaged: true, execPath: '/opt/electron', run: odd.run })
    ).toBe('safe-storage');
    expect(odd.calls).toEqual([]);
  });
});

describe('AppSecretCipher', () => {
  const secretKey = () => new SecretKeyCipher(() => KEY);

  it('in safeStorage mode, behaves as safeStorage and asks for no migration', () => {
    const safeStorage = fakeSafeStorage();
    const cipher = new AppSecretCipher('safe-storage', safeStorage, secretKey());

    const blob = cipher.encryptString('hello');

    expect(blob.toString('utf8')).toBe('v10hello');
    expect(cipher.decryptString(blob)).toBe('hello');
    expect(cipher.isEncryptionAvailable()).toBe(true);
    expect(cipher.needsReencrypt).toBeUndefined();
    expect(resealed(cipher, blob.toString('base64'))).toBeNull();
  });

  it('in secret-key mode, writes secret-key blobs and never touches safeStorage for them', () => {
    const safeStorage = fakeSafeStorage();
    const cipher = new AppSecretCipher('secret-key', safeStorage, secretKey());

    expect(cipher.isEncryptionAvailable()).toBe(true);
    const blob = cipher.encryptString('hello');

    expect(blob.subarray(0, 7).toString('ascii')).toBe('b4m-sk1');
    expect(cipher.decryptString(blob)).toBe('hello');
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('picks the backend from the blob prefix in both modes', () => {
    const legacy = Buffer.from('v10old', 'utf8');
    const current = secretKey().encryptString('new');
    for (const mode of ['safe-storage', 'secret-key'] as const) {
      const safeStorage = fakeSafeStorage();
      const cipher = new AppSecretCipher(mode, safeStorage, secretKey());

      expect(cipher.decryptString(legacy)).toBe('old');
      expect(cipher.decryptString(current)).toBe('new');
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
    }
  });

  it('in secret-key mode, marks only safeStorage blobs for re-encryption', () => {
    const cipher = new AppSecretCipher('secret-key', fakeSafeStorage(), secretKey());

    expect(cipher.needsReencrypt?.(Buffer.from('v10old'))).toBe(true);
    expect(cipher.needsReencrypt?.(cipher.encryptString('new'))).toBe(false);
    const moved = resealed(cipher, Buffer.from('v10old').toString('base64'));
    expect(moved && cipher.decryptString(Buffer.from(moved, 'base64'))).toBe('old');
    expect(moved && Buffer.from(moved, 'base64').subarray(0, 7).toString('ascii')).toBe('b4m-sk1');
  });

  it('in secret-key mode without a key, is unavailable and never falls back to safeStorage', () => {
    const safeStorage = fakeSafeStorage();
    const cipher = new AppSecretCipher('secret-key', safeStorage, new SecretKeyCipher(() => null));

    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(() => cipher.encryptString('x')).toThrow();
    expect(resealed(cipher, Buffer.from('v10old').toString('base64'))).toBeNull();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('passes through the Linux storage backend only when safeStorage has one', () => {
    const linux = new AppSecretCipher(
      'safe-storage',
      fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }),
      secretKey()
    );
    const mac = new AppSecretCipher('secret-key', fakeSafeStorage(), secretKey());

    expect(linux.getSelectedStorageBackend?.()).toBe('basic_text');
    expect(mac.getSelectedStorageBackend).toBeUndefined();
  });
});

describe('createAppSecretCipher', () => {
  it('creates the key on first use in secret-key mode, under the app-named item', () => {
    const keychain = fakeKeychain({ codesign: signature('not set') });
    const cipher = createAppSecretCipher(host({ appName: 'Bike4Mind', run: keychain.run }));

    expect(cipher.mode).toBe('secret-key');
    expect(keychain.calls.map(call => call.file)).toEqual(['/usr/bin/codesign']);
    expect(cipher.decryptString(cipher.encryptString('round trip'))).toBe('round trip');
    expect([...keychain.items.keys()]).toEqual(['Bike4Mind Secret Key|Bike4Mind']);
  });

  it('only reads the key in safeStorage mode, to open a secret-key blob', () => {
    const writer = fakeKeychain({ codesign: signature('not set') });
    const blob = createAppSecretCipher(host({ run: writer.run })).encryptString('kept');
    const reader = fakeKeychain({ codesign: signature('ABCDE12345') });
    for (const [name, value] of writer.items) reader.items.set(name, value);
    const cipher = createAppSecretCipher(host({ run: reader.run }));

    expect(cipher.mode).toBe('safe-storage');
    expect(cipher.decryptString(blob)).toBe('kept');
    expect(reader.calls.some(call => call.args[0] === '-i')).toBe(false);

    const empty = fakeKeychain({ codesign: signature('ABCDE12345') });
    expect(() => createAppSecretCipher(host({ run: empty.run })).decryptString(blob)).toThrow();
    expect(empty.calls.some(call => call.args[0] === '-i')).toBe(false);
  });

  it('reports a key it cannot load, without the key or any secret in the message', () => {
    const warn = vi.fn();
    const keychain = fakeKeychain({ codesign: signature('not set'), findStatus: 51 });
    const cipher = createAppSecretCipher(host({ run: keychain.run, warn }));

    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/secret key/i);
  });

  it('never runs the keychain tool off macOS', () => {
    const keychain = fakeKeychain();
    const cipher = createAppSecretCipher(host({ platform: 'linux', run: keychain.run }));

    expect(cipher.mode).toBe('safe-storage');
    expect(() => cipher.decryptString(Buffer.from('b4m-sk1' + 'x'.repeat(40)))).toThrow();
    expect(keychain.calls).toEqual([]);
  });
});
