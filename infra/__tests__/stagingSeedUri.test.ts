/**
 * @vitest-environment node
 *
 * Text-matched wiring: infra/dataSyncer.ts is an SST program and does not load outside
 * `sst`, so the call site is read from source while the helper is imported directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stagingSeedUri } from '../stagingSeedUri';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Mirrors the isPreviewStage expression in infra/constants.ts, minus the IS_PREVIEW env override.
const isPreviewStageName = (stage: string) => /^pr\d+$/.test(stage);

describe('stagingSeedUri', () => {
  const uri = 'mongodb://staging.example/db';

  it('passes the URI through on a preview stage', () => {
    expect(stagingSeedUri(isPreviewStageName('pr1234'), uri)).toBe(uri);
  });

  it.each(['dev', 'staging', 'production', 'personal-stage'])('returns empty on stage %s', stage => {
    expect(stagingSeedUri(isPreviewStageName(stage), uri)).toBe('');
  });

  it('returns empty on a preview stage when no URI is configured', () => {
    expect(stagingSeedUri(true, undefined)).toBe('');
    expect(stagingSeedUri(true, '')).toBe('');
  });
});

describe('preview stage definition', () => {
  it('still treats pr<digits> stages as previews, matching the local mirror above', () => {
    expect(readInfra('constants.ts')).toContain('/^pr\\d+$/.test($app.stage)');
  });
});

describe('infra/dataSyncer.ts wiring', () => {
  const source = readInfra('dataSyncer.ts');

  it('gates the staging URI on the preview stage flag', () => {
    expect(source).toMatch(
      /STAGING_MONGODB_URI:\s*stagingSeedUri\(\s*isPreviewStage\s*,\s*process\.env\.STAGING_MONGODB_URI\s*\)/
    );
  });

  it('no longer reads the staging URI ungated', () => {
    expect(source).not.toMatch(/STAGING_MONGODB_URI:\s*process\.env\.STAGING_MONGODB_URI/);
  });
});
