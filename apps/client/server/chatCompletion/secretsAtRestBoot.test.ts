import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureSecretsAtRest } from '@bike4mind/utils/security';
import { resetKeyringForTests } from '@bike4mind/utils/security/testing';
import { ensureSecretsAtRest } from './secretsAtRestBoot';

const KEY = 'a'.repeat(64);
const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('ensureSecretsAtRest', () => {
  afterEach(() => resetKeyringForTests());

  it('loads a valid key without logging', async () => {
    const logger = { error: vi.fn() };
    expect(await ensureSecretsAtRest(logger, async () => configureSecretsAtRest(KEY))).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs when no usable key ended up loaded', async () => {
    const logger = { error: vi.fn() };
    expect(await ensureSecretsAtRest(logger, async () => configureSecretsAtRest(undefined))).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not loaded on the utils instance'));
  });

  it('logs and reports false when the loader rejects and nothing loaded', async () => {
    const logger = { error: vi.fn() };
    resetKeyringForTests();
    expect(await ensureSecretsAtRest(logger, () => Promise.reject(new Error('kms down')))).toBe(false);
    expect(logger.error).toHaveBeenNthCalledWith(1, expect.stringContaining('will be retried'), expect.any(Error));
    expect(logger.error).toHaveBeenNthCalledWith(2, expect.stringContaining('not loaded on the utils instance'));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('reports true with one retry log when legacy keys loaded and then the provider unwrap failed', async () => {
    const logger = { error: vi.fn() };
    const load = async () => {
      configureSecretsAtRest(KEY);
      throw new Error('kms down');
    };
    expect(await ensureSecretsAtRest(logger, load)).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('will be retried'), expect.any(Error));
  });
});

// The hosted process shape: tsx runs apps/client as CommonJS, so services and this boot module
// share the utils .cjs copy while the ESM-only database package configures the .mjs copy.
describe('ensureSecretsAtRest in a CommonJS tsx process', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-at-rest-boot-'));
    writeFileSync(
      join(dir, 'probe.ts'),
      `
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const req = require('node:module').createRequire(process.env.CLIENT_DIR + '/package.json');
const servicesEntry = req.resolve('@bike4mind/services/llm');
const servicesUtils = req(req.resolve('@bike4mind/utils/security', { paths: [path.dirname(servicesEntry)] }));
const bootUtils = req('@bike4mind/utils/security');
const key = process.env.PROBE_KEY;
(async () => {
  // The ESM copy is what the database package loads in the hosted process.
  const esmPath = req.resolve('@bike4mind/utils/security').replace(/\\.cjs$/, '.mjs');
  const esmUtils = await import(pathToFileURL(esmPath).href);
  const ciphertext = bootUtils.encryptSecret('probe-plaintext', key);
  const before = servicesUtils.isKeyringLoaded();
  const { ensureSecretsAtRest } = require(process.env.BOOT_MODULE);
  const ok = await ensureSecretsAtRest({ error() {} }, () =>
    esmUtils.ensureKeyring({ provider: esmUtils.createStaticKeyProvider(key), legacyKey: key })
  );
  console.log(JSON.stringify({
    distinctInstances: esmUtils.ensureKeyring !== servicesUtils.ensureKeyring,
    before,
    ok,
    servicesSeesKeyring: servicesUtils.isKeyringLoaded(),
    decrypted: servicesUtils.decryptAtRest(ciphertext),
    esmDecrypted: esmUtils.decryptAtRest(ciphertext),
  }));
})();
`
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a keyring loaded by the ESM utils copy is the one the services-side CJS copy reads', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(dir, 'probe.ts')], {
      cwd: clientDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLIENT_DIR: clientDir,
        PROBE_KEY: KEY,
        BOOT_MODULE: join(dirname(fileURLToPath(import.meta.url)), 'secretsAtRestBoot.ts'),
      },
    });
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({
      distinctInstances: true,
      before: false,
      ok: true,
      servicesSeesKeyring: true,
      decrypted: 'probe-plaintext',
      esmDecrypted: 'probe-plaintext',
    });
  });
});
