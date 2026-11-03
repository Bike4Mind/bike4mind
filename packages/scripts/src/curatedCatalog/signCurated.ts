/**
 * Signs the curated list with a maintainer key held outside the repo, adding to the signatures already there for
 * the same sequence (rotation overlap, or recovery plus signing).
 *
 *   pnpm --filter @bike4mind/scripts curated:sign --key <encrypted-pem> [--manifest <path>] [--sig <path>]
 */
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  curatedPublicKey,
  parseCuratedKey,
  parseCuratedSignatureFile,
  signCurated,
  verifyCurated,
  type CuratedKey,
  type CuratedSignatureEntry,
} from '@bike4mind/local-models';
import { KEYRING_PATH } from './catalogChecks';
import { CATALOG_PATH, cliPath, isEntry, isInside, readPassphrase, REPO_ROOT } from './cli';

const MAX_SIGNATURES = 4;

export interface SignResult {
  text: string;
  keyId: string;
  kept: string[];
  dropped: string[];
}

/**
 * The signature file for `manifest` with `privateKey`'s entry added. Existing entries survive only for the same
 * sequence and only when they verify over these bytes under `keyring`; anything else is dropped and reported.
 */
export function signManifest(
  manifest: Uint8Array,
  privateKey: KeyObject,
  existing: Uint8Array | null,
  keyring: readonly CuratedKey[]
): SignResult {
  const sequence: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest)).sequence;
  if (!Number.isInteger(sequence)) throw new Error('the list has no integer sequence');
  const { keyId } = curatedPublicKey(privateKey);
  const kept: CuratedSignatureEntry[] = [];
  const dropped: string[] = [];
  const previous = existing ? parseCuratedSignatureFile(existing) : null;
  for (const entry of previous?.signatures ?? []) {
    if (entry.keyId === keyId) continue;
    const key = keyring.find(candidate => candidate.keyId === entry.keyId);
    const single = Buffer.from(JSON.stringify({ signatures: [entry] }));
    if (previous?.sequence === sequence && key && verifyCurated(manifest, single, [key]).ok) kept.push(entry);
    else dropped.push(entry.keyId);
  }
  const signatures = [...kept, { keyId, sig: signCurated(manifest, privateKey) }];
  if (signatures.length > MAX_SIGNATURES) throw new Error(`a list carries at most ${MAX_SIGNATURES} signatures`);
  return {
    text: `${JSON.stringify({ sequence, signatures }, null, 2)}\n`,
    keyId,
    kept: kept.map(entry => entry.keyId),
    dropped,
  };
}

export function loadPrivateKey(pem: string, passphrase: string): KeyObject {
  const key = createPrivateKey({ key: pem, format: 'pem', passphrase });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the key is not an Ed25519 private key');
  return key;
}

async function readKeyring(file: string): Promise<CuratedKey[]> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  return (Array.isArray(raw) ? raw : []).flatMap(entry => {
    const key = parseCuratedKey(entry);
    return key ? [key] : [];
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, log = console.log): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { key: { type: 'string' }, manifest: { type: 'string' }, sig: { type: 'string' } },
  });
  if (!values.key) {
    log('usage: curated:sign --key <encrypted-pem> [--manifest <path>] [--sig <path>]');
    return 2;
  }
  const keyFile = cliPath(values.key, env);
  if (isInside(keyFile, REPO_ROOT)) {
    log('refused: keep the private key outside the repository');
    return 1;
  }
  const manifestFile = values.manifest ? cliPath(values.manifest, env) : path.join(REPO_ROOT, CATALOG_PATH);
  const sigFile = values.sig ? cliPath(values.sig, env) : `${manifestFile}.sig`;
  try {
    const privateKey = loadPrivateKey(await readFile(keyFile, 'utf8'), await readPassphrase(env, false));
    const manifest = new Uint8Array(await readFile(manifestFile));
    const existing = await readFile(sigFile).then(
      bytes => new Uint8Array(bytes),
      () => null
    );
    const keyring = await readKeyring(path.join(REPO_ROOT, KEYRING_PATH));
    const result = signManifest(manifest, privateKey, existing, keyring);
    await writeFile(sigFile, result.text);
    log(`signed with ${result.keyId}; kept ${result.kept.join(', ') || 'no other signature'}`);
    if (result.dropped.length > 0) log(`dropped signatures that no longer verify: ${result.dropped.join(', ')}`);
    if (!keyring.some(key => key.keyId === result.keyId))
      log(`warning: ${result.keyId} is not in ${KEYRING_PATH}, so no Desktop trusts it yet`);
    return 0;
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) main(process.argv.slice(2), process.env).then(code => (process.exitCode = code));
