import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseUpdatePublicKeys, verifyManifestSignature } from './manifestSignature';

const SCRIPT = fileURLToPath(new URL('../../../scripts/sign-update-manifests.mjs', import.meta.url));
const MANIFESTS = ['latest-linux.yml', 'latest-mac.yml', 'latest.yml'];

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    encoded: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DESKTOP_UPDATE_SIGNING_KEY: '',
      DESKTOP_UPDATE_PUBLIC_KEYS: '',
      B4M_UPDATE_PUBLIC_KEYS: '',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scripts/sign-update-manifests.mjs', () => {
  const signer = keyPair();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'update-signing-'));
    for (const [index, name] of MANIFESTS.entries()) {
      await writeFile(join(dir, name), `version: 0.2.${index}\nfiles: []\n`);
    }
    await writeFile(join(dir, 'SHA256SUMS.txt'), 'abc  latest.yml\n');
    await writeFile(join(dir, 'install.sh'), '#!/bin/sh\n');
  });

  it('writes signatures the app verifies, and only for manifests', async () => {
    const result = run(['sign', dir], {
      DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
      DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Signed and verified: ${MANIFESTS.join(', ')}\n`);

    const keys = parseUpdatePublicKeys(signer.encoded);
    if (keys.kind !== 'keys') throw new Error('fixture key did not parse');
    expect((await readdir(dir)).filter(name => name.endsWith('.sig')).sort()).toEqual(
      MANIFESTS.map(name => `${name}.sig`)
    );
    for (const name of MANIFESTS) {
      const signature = await readFile(join(dir, `${name}.sig`), 'utf8');
      expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
      expect(verifyManifestSignature(name, await readFile(join(dir, name)), signature, keys.keys)).toBe(true);
    }
    // Each signature is bound to its own manifest's name.
    const linuxSignature = await readFile(join(dir, 'latest-linux.yml.sig'), 'utf8');
    expect(
      verifyManifestSignature('latest.yml', await readFile(join(dir, 'latest-linux.yml')), linuxSignature, keys.keys)
    ).toBe(false);
  });

  it('fails without printing the key when the signing key is not one of the listed keys', () => {
    const result = run(['sign', dir], {
      DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
      DESKTOP_UPDATE_PUBLIC_KEYS: keyPair().encoded,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('latest-linux.yml.sig does not verify under any key in DESKTOP_UPDATE_PUBLIC_KEYS\n');
    expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
  });

  it('fails on a missing or unusable signing key or key list', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const cases: [Record<string, string>, string][] = [
      [{ DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded }, 'DESKTOP_UPDATE_SIGNING_KEY is empty'],
      [
        { DESKTOP_UPDATE_SIGNING_KEY: 'not a key', DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded },
        'DESKTOP_UPDATE_SIGNING_KEY is not a PEM private key',
      ],
      [
        { DESKTOP_UPDATE_SIGNING_KEY: rsa.toString(), DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded },
        'DESKTOP_UPDATE_SIGNING_KEY is not an Ed25519 key',
      ],
      [{ DESKTOP_UPDATE_SIGNING_KEY: signer.pem }, 'DESKTOP_UPDATE_PUBLIC_KEYS is empty'],
      [
        { DESKTOP_UPDATE_SIGNING_KEY: signer.pem, DESKTOP_UPDATE_PUBLIC_KEYS: `${signer.encoded},oops` },
        'DESKTOP_UPDATE_PUBLIC_KEYS entry 2 is not a base64 Ed25519 SPKI public key',
      ],
    ];
    for (const [env, message] of cases) {
      const result = run(['sign', dir], env);
      expect(result.status, message).toBe(1);
      expect(result.stderr).toBe(`${message}\n`);
    }
  });

  it('fails when there is nothing to sign', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'update-signing-empty-'));
    const result = run(['sign', empty], {
      DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
      DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^No update manifests in /);
  });

  it('verify requires a valid signature for every manifest, under any listed key', async () => {
    const env = { DESKTOP_UPDATE_SIGNING_KEY: signer.pem, DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded };
    expect(run(['sign', dir], env).status).toBe(0);
    const previous = keyPair().encoded;
    expect(run(['verify', dir], { DESKTOP_UPDATE_PUBLIC_KEYS: `${previous},${signer.encoded}` }).status).toBe(0);
    expect(run(['verify', dir], { DESKTOP_UPDATE_PUBLIC_KEYS: previous }).status).toBe(1);

    await writeFile(join(dir, 'latest.yml'), 'version: 9.9.9\nfiles: []\n');
    expect(run(['verify', dir], env).stderr).toBe(
      'latest.yml.sig does not verify under any key in DESKTOP_UPDATE_PUBLIC_KEYS\n'
    );

    await rm(join(dir, 'latest-mac.yml.sig'));
    expect(run(['verify', dir], env).stderr).toBe('latest-mac.yml.sig is missing\n');
  });

  describe('check-build', () => {
    async function bundle(source: string): Promise<string> {
      const out = join(dir, 'out');
      await mkdir(join(out, 'main', 'chunks'), { recursive: true });
      await writeFile(join(out, 'main', 'index.js'), 'require("./chunks/update.js");\n');
      await writeFile(join(out, 'main', 'chunks', 'update.js'), source);
      return out;
    }

    it('passes when every configured key is baked into the main bundle', async () => {
      const other = keyPair().encoded;
      const keys = `${signer.encoded},${other}`;
      const out = await bundle(`const CONFIGURED_PUBLIC_KEYS = ${JSON.stringify(keys)};\n`);
      const result = run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys });
      expect(result.stdout).toBe('The main bundle carries all 2 update key(s)\n');
      expect(result.status).toBe(0);
    });

    it('fails when a configured key is missing or still read at runtime', async () => {
      const keys = `${signer.encoded},${keyPair().encoded}`;
      let out = await bundle(`const CONFIGURED_PUBLIC_KEYS = ${JSON.stringify(signer.encoded)};\n`);
      expect(run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys }).stderr).toBe(
        'B4M_UPDATE_PUBLIC_KEYS entry 2 is not in the main bundle\n'
      );

      out = await bundle('const CONFIGURED_PUBLIC_KEYS = process.env.B4M_UPDATE_PUBLIC_KEYS;\n');
      expect(run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys }).stderr).toBe(
        'The main bundle still reads process.env.B4M_UPDATE_PUBLIC_KEYS at runtime\n'
      );

      expect(run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: 'not-a-key' }).status).toBe(1);
    });

    it('has nothing to check when no keys are configured', async () => {
      const out = await bundle('const CONFIGURED_PUBLIC_KEYS = "";\n');
      const result = run(['check-build', out], {});
      expect(result.stdout).toBe('No update keys configured\n');
      expect(result.status).toBe(0);
    });
  });
});
