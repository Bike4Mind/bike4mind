/**
 * Generates a curated-list key pair: the private key as passphrase-encrypted PKCS8 PEM outside the repo, and the
 * public entry to add to apps/desktop/src/main/models/curated/keys.json.
 *
 *   pnpm --filter @bike4mind/scripts curated:keygen --out <path-outside-repo> --role signing|recovery
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CURATED_KEY_ROLES, curatedKeyId, type CuratedKey, type CuratedKeyRole } from '@bike4mind/local-models';
import { cliPath, isEntry, isInside, readPassphrase, REPO_ROOT } from './cli';

const MIN_PASSPHRASE = 12;

export function generateCuratedKey(role: CuratedKeyRole, passphrase: string): { pem: string; entry: CuratedKey } {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const spki = publicKey.toString('base64');
  const keyId = curatedKeyId(spki);
  if (!keyId) throw new Error('generated key is not Ed25519');
  return { pem: privateKey, entry: { keyId, spki, role } };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log = console.log): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, role: { type: 'string' } } });
  const role = CURATED_KEY_ROLES.find(known => known === values.role);
  if (!values.out || !role) {
    log('usage: curated:keygen --out <path-outside-repo> --role signing|recovery');
    return 2;
  }
  const out = cliPath(values.out, env);
  if (isInside(out, REPO_ROOT)) {
    log('refused: write the private key outside the repository');
    return 1;
  }
  try {
    const { pem, entry } = generateCuratedKey(role, await readPassphrase(env, true));
    await writeFile(out, pem, { flag: 'wx', mode: 0o600 });
    log(`wrote the encrypted ${role} key to ${out}`);
    log(`add this entry to apps/desktop/src/main/models/curated/keys.json:\n${JSON.stringify(entry, null, 2)}`);
    return 0;
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) main(process.argv.slice(2), process.env).then(code => (process.exitCode = code));
