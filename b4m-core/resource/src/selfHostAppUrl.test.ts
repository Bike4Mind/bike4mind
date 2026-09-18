import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pins `APP_URL` into the self-host env template.
 *
 * `APP_URL` is the CSRF origin allow-list (apps/client/server/middlewares/csrfProtection.ts) and it
 * fails CLOSED: with it unset, every state-changing request on the routes that opt into that
 * middleware answers 403 "CSRF: APP_URL is not configured on this deployment." GET/HEAD/OPTIONS are
 * exempt, so reads keep working and the symptom reads as a permissions bug rather than as one
 * missing variable.
 *
 * Hosted stages get the value injected per-construct (infra/web.ts); self-host has no injector, so
 * this template is the only thing that sets it. It was absent from the template entirely while 48
 * route files opted into the middleware, which is the gap this pins.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function envValue(file: string, key: string): string | undefined {
  const contents = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  return new RegExp(`^${key}=(.*)$`, 'm').exec(contents)?.[1];
}

function expectBareOrigin(value: string | undefined) {
  expect(value).toBeDefined();
  // csrfProtection compares request origins against `new URL(APP_URL).origin`, so anything that is
  // not already a bare origin yields an allow-list entry no request can ever match - a 403 on every
  // mutation, indistinguishable from the unset case until you read the middleware. That covers a
  // trailing slash or a path, and equally a scheme whose origin serializes to the string "null"
  // (e.g. `file:`), which `origin === value` already excludes since `new URL('null')` throws.
  expect(() => new URL(value!)).not.toThrow();
  expect(new URL(value!).origin).toBe(value);
}

describe('self-host APP_URL', () => {
  it('is declared in .env.selfhost.example', () => {
    expect(envValue('.env.selfhost.example', 'APP_URL')).toBeDefined();
  });

  it('is a bare absolute origin, the only shape csrfProtection can match', () => {
    expectBareOrigin(envValue('.env.selfhost.example', 'APP_URL'));
  });

  // SELF_HOST.md Path B points operators at this block as "the full copy-pasteable" set of exposure
  // vars. An APP_URL missing here leaves a public deployment on the template's localhost default,
  // which is the same 403 relocated to the origin they actually browse from.
  it('is overridden in the public-exposure block, not left at the localhost default', () => {
    const exposed = envValue('selfhost/env-additions.txt', 'APP_URL');
    expectBareOrigin(exposed);
    expect(exposed).not.toBe(envValue('.env.selfhost.example', 'APP_URL'));
  });
});
