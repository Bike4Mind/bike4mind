// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { ApiKeyScope, CONFINED_API_KEY_SCOPES } from '@bike4mind/common';
import { decideScopeGate } from '@server/middlewares/apiKeyScopeGate';
import { FILES_WRITE_OR_RELEASE_NOTES_SCOPES } from '@server/files/fileScopes';
import { stripComments, tsFiles } from './scopeCoverageHelpers';

/**
 * `release-notes:write` exists so the release-video job can find a note, upload its media and set
 * its video without an `admin:*` key. It is confined, so its reach is exactly the routes that name
 * it; this scan pins that set, and the gate cases pin what confinement means for it at runtime.
 */
const PAGES_API = path.join(__dirname, '..', '..', 'pages', 'api');
const SERVER = path.join(__dirname, '..');
const SERVER_UTILS = path.join(__dirname, '..', '..', '..', '..', 'packages', 'server-utils', 'src');

const EXPECTED_REFERENCES = [
  'pages/api/admin/release-notes/[id].ts',
  'pages/api/admin/release-notes/index.ts',
  'pages/api/admin/users/[userId]/generate-api-key.ts',
  'server/files/fileScopes.ts',
  // Reads the scope to skip IP-baseline alerts for the job's CI runners; grants no reach.
  'server/middlewares/apiKeyAnomalyDetection.ts',
];

const rel = (f: string) =>
  path
    .relative(path.join(__dirname, '..', '..'), f)
    .split(path.sep)
    .join('/');

describe('release-notes:write reach', () => {
  it('is confined', () => {
    expect(CONFINED_API_KEY_SCOPES).toContain(ApiKeyScope.RELEASE_NOTES_WRITE);
  });

  it('is named only by the release-note routes, the createFabFile gate, the admin mint and anomaly detection', () => {
    const referencing = [...tsFiles(PAGES_API), ...tsFiles(SERVER), ...tsFiles(SERVER_UTILS)]
      .filter(f => !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}__tests__${path.sep}`))
      .filter(f => /ApiKeyScope\.RELEASE_NOTES_WRITE\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel)
      .sort();
    expect(referencing).toEqual(EXPECTED_REFERENCES);
  });

  const KEY = [ApiKeyScope.RELEASE_NOTES_WRITE];
  const NONE_STAGED = new Set<string>();
  const RELEASE_NOTE_ROUTE = [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE];

  it.each([
    ['a release-note route', RELEASE_NOTE_ROUTE, 'allow'],
    ['createFabFile', FILES_WRITE_OR_RELEASE_NOTES_SCOPES, 'allow'],
    ['any other admin route', [ApiKeyScope.ADMIN], 'deny'],
    ['a files:write route', [ApiKeyScope.WRITE_FILES], 'deny'],
    ['a route that declares no scope', undefined, 'deny'],
  ] as const)('a release-notes:write key on %s: %s', (_route, required, outcome) => {
    const decision = decideScopeGate(required ? [...required] : undefined, KEY, NONE_STAGED);
    expect(decision.outcome).toBe(outcome);
  });

  it('cannot be staged into a route it is not named on', () => {
    expect(decideScopeGate([ApiKeyScope.ADMIN], KEY, new Set([ApiKeyScope.ADMIN])).outcome).toBe('deny');
  });

  it('leaves an admin:* key passing the release-note routes', () => {
    expect(decideScopeGate(RELEASE_NOTE_ROUTE, [ApiKeyScope.ADMIN], NONE_STAGED).outcome).toBe('allow');
  });
});
