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

function envTemplateValue(key: string): string | undefined {
  const contents = fs.readFileSync(path.join(REPO_ROOT, '.env.selfhost.example'), 'utf8');
  return new RegExp(`^${key}=(.*)$`, 'm').exec(contents)?.[1];
}

describe('self-host APP_URL', () => {
  it('is declared in .env.selfhost.example', () => {
    expect(envTemplateValue('APP_URL')).toBeDefined();
  });

  it('is a bare absolute origin, the only shape csrfProtection can match', () => {
    const value = envTemplateValue('APP_URL');
    expect(value).toBeDefined();
    // csrfProtection compares request origins against `new URL(APP_URL).origin`, so a trailing
    // slash or a path yields an allow-list entry no request can ever match - a 403 on every
    // mutation, indistinguishable from the unset case until you read the middleware.
    expect(() => new URL(value!)).not.toThrow();
    expect(new URL(value!).origin).toBe(value);
    // `new URL()` accepts schemes whose origin serializes to the string "null" (e.g. `file:`),
    // which the middleware rejects for the same reason.
    expect(new URL(value!).origin).not.toBe('null');
  });
});
