import { randomBytes } from 'node:crypto';
import type { ProcessRunner } from './runProcess';

const SECURITY = '/usr/bin/security';
const ITEM_NOT_FOUND = 44;
const KEY_BYTES = 32;
/** Long enough for the user to answer a keychain unlock prompt. */
const KEYCHAIN_TIMEOUT_MS = 60_000;

export interface KeychainItem {
  service: string;
  account: string;
}

export type SecretKeyLoad =
  { state: 'found'; key: Buffer } | { state: 'missing' } | { state: 'failed'; reason: string };

/** Per app name, like safeStorage's own "<name> Safe Storage" item, so dev and release keys stay apart. */
export function secretKeyItem(appName: string): KeychainItem {
  return { service: `${appName} Secret Key`, account: appName };
}

/**
 * The app's secret key from the login keychain, created when missing and `create` is set. The item
 * is read and written through /usr/bin/security: macOS binds a keychain item to the build that
 * created it unless the certificate is Apple-issued, and this tool's binding outlives app updates.
 */
export function loadSecretKey(item: KeychainItem, run: ProcessRunner, { create }: { create: boolean }): SecretKeyLoad {
  const found = readSecretKey(item, run);
  if (found.state !== 'missing' || !create) return found;
  // No -U: if another instance created the item first, this add fails and both use its key.
  addSecretKey(item, randomBytes(KEY_BYTES), run);
  return readSecretKey(item, run);
}

function readSecretKey(item: KeychainItem, run: ProcessRunner): SecretKeyLoad {
  const result = run(SECURITY, ['find-generic-password', '-a', item.account, '-s', item.service, '-w'], {
    timeoutMs: KEYCHAIN_TIMEOUT_MS,
  });
  if (result.status === ITEM_NOT_FOUND) return { state: 'missing' };
  if (result.status !== 0) return { state: 'failed', reason: `security exited with ${result.status ?? 'no status'}` };
  const encoded = result.stdout.trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
    return { state: 'failed', reason: 'the stored key is not 32 bytes of base64' };
  }
  return { state: 'found', key };
}

/** `security -i` reads the command from stdin, which keeps the key out of every process's arguments. */
function addSecretKey(item: KeychainItem, key: Buffer, run: ProcessRunner): void {
  const account = quoted(item.account);
  const service = quoted(item.service);
  if (!account || !service) return;
  run(SECURITY, ['-i'], {
    input: `add-generic-password -a ${account} -s ${service} -w ${key.toString('base64')}\n`,
    timeoutMs: KEYCHAIN_TIMEOUT_MS,
  });
}

/** Printable ASCII without `"` or `\`, so the quoted name reaches the tool exactly as written. */
function quoted(value: string): string | null {
  return /^[ !#-[\]-~]+$/.test(value) ? `"${value}"` : null;
}
