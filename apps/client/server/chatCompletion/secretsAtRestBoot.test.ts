import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSecretsAtRestConfigured, configureSecretsAtRest } from '@bike4mind/utils/security';
import { registerSecretsAtRest } from './secretsAtRestBoot';

const KEY = 'a'.repeat(64);
const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('registerSecretsAtRest', () => {
  it('registers a valid key without logging', () => {
    const logger = { error: vi.fn() };
    expect(registerSecretsAtRest(logger, KEY)).toBe(true);
    expect(isSecretsAtRestConfigured()).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    configureSecretsAtRest(undefined);
  });

  it('logs when no usable key is configured', () => {
    const logger = { error: vi.fn() };
    expect(registerSecretsAtRest(logger, undefined)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// The hosted process shape: tsx runs apps/client as CommonJS, so services and this boot module
// share the utils .cjs copy while the ESM-only database package configures the .mjs copy.
describe('registerSecretsAtRest in a CommonJS tsx process', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(clientDir, '.secrets-at-rest-boot-'));
    writeFileSync(
      join(dir, 'probe.ts'),
      `
const path = require('node:path');
const req = require('node:module').createRequire(process.env.CLIENT_DIR + '/package.json');
const servicesEntry = req.resolve('@bike4mind/services/llm');
const servicesUtils = req(req.resolve('@bike4mind/utils/security', { paths: [path.dirname(servicesEntry)] }));
const bootUtils = req('@bike4mind/utils/security');
const key = process.env.PROBE_KEY;
const ciphertext = bootUtils.encryptSecret('probe-plaintext', key);
const before = servicesUtils.isSecretsAtRestConfigured();
const logger = { error() {} };
const { registerSecretsAtRest } = require(process.env.BOOT_MODULE);
registerSecretsAtRest(logger, key);
console.log(JSON.stringify({
  same: servicesUtils === bootUtils,
  before,
  after: servicesUtils.isSecretsAtRestConfigured(),
  decrypted: servicesUtils.decryptAtRest(ciphertext),
}));
`
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('configures the instance @bike4mind/services resolves, so it decrypts', () => {
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
      same: true,
      before: false,
      after: true,
      decrypted: 'probe-plaintext',
    });
  });
});
