import { posix } from 'node:path';
import type { SecretCipher } from '../chat/mcp/McpServerStore';
import { loadSecretKey, secretKeyItem } from './keychainKey';
import type { ProcessRunner } from './runProcess';
import { isSecretKeyBlob, SecretKeyCipher } from './secretKeyCipher';

const CODESIGN = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 15_000;

/** `safe-storage` is Electron's safeStorage as before; `secret-key` is the app's own key in the login keychain. */
export type SecretCipherMode = 'safe-storage' | 'secret-key';

type SafeStorage = SecretCipher & { getSelectedStorageBackend?(): string };

export interface AppSecretCipherHost {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  /** Started with Chromium's --use-mock-keychain: nothing may reach the real keychain. */
  mockKeychain?: boolean;
  appName: string;
  safeStorage: SafeStorage;
  run: ProcessRunner;
  warn(message: string): void;
}

/** The `.app` bundle holding a macOS executable at `<bundle>.app/Contents/MacOS/<name>`. */
export function macBundlePath(execPath: string): string | null {
  const macOS = posix.dirname(execPath);
  const contents = posix.dirname(macOS);
  const bundle = posix.dirname(contents);
  const fits = posix.basename(macOS) === 'MacOS' && posix.basename(contents) === 'Contents' && bundle.endsWith('.app');
  return fits ? bundle : null;
}

/**
 * `secret-key` for a packaged macOS build whose signature has no team identifier (ad-hoc or
 * self-signed): macOS ties safeStorage's keychain item to the exact build unless the certificate
 * is Apple-issued, so every update would ask for the keychain password. Everything else, a
 * signature that cannot be read included, keeps `safe-storage`.
 */
export function selectSecretCipherMode(
  host: Pick<AppSecretCipherHost, 'platform' | 'isPackaged' | 'execPath' | 'run' | 'mockKeychain'>
): SecretCipherMode {
  if (host.platform !== 'darwin' || !host.isPackaged || host.mockKeychain) return 'safe-storage';
  const bundle = macBundlePath(host.execPath);
  if (!bundle) return 'safe-storage';
  const result = host.run(CODESIGN, ['-dv', '--verbose=2', bundle], { timeoutMs: CODESIGN_TIMEOUT_MS });
  if (result.status !== 0) return 'safe-storage';
  // codesign -d writes its report to stderr.
  const team = /^TeamIdentifier=(.*)$/m.exec(`${result.stderr}\n${result.stdout}`)?.[1]?.trim();
  return team === 'not set' ? 'secret-key' : 'safe-storage';
}

/**
 * The cipher every secret store uses. Decryption follows the blob's own format, so either kind
 * stays readable in both modes; encryption follows the mode. In `secret-key` mode an unavailable
 * key makes the whole cipher unavailable rather than falling back to safeStorage.
 */
export class AppSecretCipher implements SafeStorage {
  /** Set in `secret-key` mode only: true for a safeStorage blob, which the stores then re-save. */
  readonly needsReencrypt?: (encrypted: Buffer) => boolean;
  readonly getSelectedStorageBackend?: () => string;

  constructor(
    readonly mode: SecretCipherMode,
    private readonly safeStorage: SafeStorage,
    private readonly secretKey: SecretKeyCipher
  ) {
    if (mode === 'secret-key') this.needsReencrypt = encrypted => !isSecretKeyBlob(encrypted);
    const backend = safeStorage.getSelectedStorageBackend;
    if (typeof backend === 'function') this.getSelectedStorageBackend = () => backend.call(safeStorage);
  }

  isEncryptionAvailable(): boolean {
    return this.mode === 'secret-key'
      ? this.secretKey.isEncryptionAvailable()
      : this.safeStorage.isEncryptionAvailable();
  }

  encryptString(plainText: string): Buffer {
    return this.mode === 'secret-key'
      ? this.secretKey.encryptString(plainText)
      : this.safeStorage.encryptString(plainText);
  }

  decryptString(encrypted: Buffer): string {
    return isSecretKeyBlob(encrypted)
      ? this.secretKey.decryptString(encrypted)
      : this.safeStorage.decryptString(encrypted);
  }
}

export function createAppSecretCipher(host: AppSecretCipherHost): AppSecretCipher {
  const mode = selectSecretCipherMode(host);
  const item = secretKeyItem(host.appName);
  const secretKey = new SecretKeyCipher(() => {
    if (host.platform !== 'darwin' || host.mockKeychain) return null;
    // Only `secret-key` mode creates the key; the other mode reads one only to open its blobs.
    const loaded = loadSecretKey(item, host.run, { create: mode === 'secret-key' });
    if (loaded.state === 'found') return loaded.key;
    host.warn(
      `SECRETS: the secret key is not available (${loaded.state === 'missing' ? 'no keychain item' : loaded.reason})`
    );
    return null;
  });
  return new AppSecretCipher(mode, host.safeStorage, secretKey);
}
