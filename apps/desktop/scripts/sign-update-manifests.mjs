// Signs and checks the desktop update manifests; see "Signed update manifests" in apps/desktop/README.md.
//
//   node sign-update-manifests.mjs sign <dir>          writes <name>.sig for every *.yml in <dir>, then verifies them
//   node sign-update-manifests.mjs verify <dir>        every *.yml in <dir> has a .sig that verifies under a listed key
//   node sign-update-manifests.mjs check-build <out>   the built main bundle carries every key in B4M_UPDATE_PUBLIC_KEYS
//
// The private key comes only from DESKTOP_UPDATE_SIGNING_KEY (PKCS8 PEM). sign and verify trust the keys in
// DESKTOP_UPDATE_PUBLIC_KEYS, written exactly as the app's B4M_UPDATE_PUBLIC_KEYS.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must stay in sync with MANIFEST_SIGNATURE_CONTEXT and manifestSignatureMessage in
// src/main/update/manifestSignature.ts; signUpdateManifests.test.ts signs here and verifies there.
export const MANIFEST_SIGNATURE_CONTEXT = 'b4m-desktop-update-manifest-v1';
const MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/;
const SIGNATURE_BYTES = 64;

function isBase64(text) {
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

export function manifestMessage(name, manifest) {
  if (!MANIFEST_NAME.test(name)) throw new Error(`Not an update manifest name: ${JSON.stringify(name)}`);
  return Buffer.concat([Buffer.from(`${MANIFEST_SIGNATURE_CONTEXT}\n${name}\n`, 'utf8'), manifest]);
}

export function parsePublicKeys(raw, variable) {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') throw new Error(`${variable} is empty`);
  return trimmed.split(',').map((entry, index) => {
    const text = entry.trim();
    const der = Buffer.from(text, 'base64');
    let key = null;
    try {
      if (isBase64(text)) key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch {
      key = null;
    }
    if (key?.asymmetricKeyType !== 'ed25519' || !key.export({ format: 'der', type: 'spki' }).equals(der)) {
      throw new Error(`${variable} entry ${index + 1} is not a base64 Ed25519 SPKI public key`);
    }
    return key;
  });
}

export function signManifest(name, manifest, privateKey) {
  return `${sign(null, manifestMessage(name, manifest), privateKey).toString('base64')}\n`;
}

export function verifyManifest(name, manifest, signatureText, keys) {
  const body = signatureText.trim();
  if (!isBase64(body)) return false;
  const signature = Buffer.from(body, 'base64');
  if (signature.length !== SIGNATURE_BYTES) return false;
  const message = manifestMessage(name, manifest);
  return keys.some(key => verify(null, message, key, signature));
}

function manifests(dir) {
  const names = readdirSync(dir)
    .filter(name => name.endsWith('.yml'))
    .sort();
  if (names.length === 0) throw new Error(`No update manifests in ${dir}`);
  return names;
}

function signingKey(pem) {
  if (!pem?.trim()) throw new Error('DESKTOP_UPDATE_SIGNING_KEY is empty');
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser's own message is not repeated: it is the only text here derived from the key.
    throw new Error('DESKTOP_UPDATE_SIGNING_KEY is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('DESKTOP_UPDATE_SIGNING_KEY is not an Ed25519 key');
  return key;
}

export function verifyFolder(dir, env) {
  const keys = parsePublicKeys(env.DESKTOP_UPDATE_PUBLIC_KEYS, 'DESKTOP_UPDATE_PUBLIC_KEYS');
  const names = manifests(dir);
  for (const name of names) {
    let signature;
    try {
      signature = readFileSync(join(dir, `${name}.sig`), 'utf8');
    } catch {
      throw new Error(`${name}.sig is missing`);
    }
    if (!verifyManifest(name, readFileSync(join(dir, name)), signature, keys)) {
      throw new Error(`${name}.sig does not verify under any key in DESKTOP_UPDATE_PUBLIC_KEYS`);
    }
  }
  return names;
}

export function signFolder(dir, env) {
  const privateKey = signingKey(env.DESKTOP_UPDATE_SIGNING_KEY);
  parsePublicKeys(env.DESKTOP_UPDATE_PUBLIC_KEYS, 'DESKTOP_UPDATE_PUBLIC_KEYS');
  for (const name of manifests(dir)) {
    writeFileSync(join(dir, `${name}.sig`), signManifest(name, readFileSync(join(dir, name)), privateKey));
  }
  return verifyFolder(dir, env);
}

/** The keys a build with B4M_UPDATE_PUBLIC_KEYS set must carry; none to check when it is unset. */
export function checkBuild(outDir, env) {
  const raw = (env.B4M_UPDATE_PUBLIC_KEYS ?? '').trim();
  if (raw === '') return 0;
  parsePublicKeys(raw, 'B4M_UPDATE_PUBLIC_KEYS');
  const main = join(outDir, 'main');
  const bundle = readdirSync(main, { recursive: true })
    .filter(name => /\.[cm]?js$/.test(name))
    .map(name => readFileSync(join(main, name), 'utf8'))
    .join('\n');
  if (bundle.includes('process.env.B4M_UPDATE_PUBLIC_KEYS')) {
    throw new Error('The main bundle still reads process.env.B4M_UPDATE_PUBLIC_KEYS at runtime');
  }
  const entries = raw.split(',').map(entry => entry.trim());
  for (const [index, entry] of entries.entries()) {
    if (!bundle.includes(entry)) throw new Error(`B4M_UPDATE_PUBLIC_KEYS entry ${index + 1} is not in the main bundle`);
  }
  return entries.length;
}

function main([command, dir]) {
  if (!dir) throw new Error('usage: sign-update-manifests.mjs sign|verify|check-build <dir>');
  if (command === 'sign') {
    console.log(`Signed and verified: ${signFolder(dir, process.env).join(', ')}`);
  } else if (command === 'verify') {
    console.log(`Verified: ${verifyFolder(dir, process.env).join(', ')}`);
  } else if (command === 'check-build') {
    const count = checkBuild(dir, process.env);
    console.log(count === 0 ? 'No update keys configured' : `The main bundle carries all ${count} update key(s)`);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
