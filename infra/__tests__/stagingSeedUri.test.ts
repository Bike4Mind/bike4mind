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
const URI = 'mongodb://staging.example/db';

describe('stagingSeedUri', () => {
  it('passes the value through on a preview stage', () => {
    expect(stagingSeedUri('pr123', URI)).toBe(URI);
  });

  it.each(['dev', 'staging', 'production', 'prod', 'poy', 'pr', 'pr123x', 'xpr123', 'pr-123'])(
    'withholds the value on stage %s',
    stage => {
      expect(stagingSeedUri(stage, URI)).toBe('');
    }
  );

  it('is empty on a preview stage when no value is configured', () => {
    expect(stagingSeedUri('pr123', undefined)).toBe('');
    expect(stagingSeedUri('pr123', '')).toBe('');
  });
});

describe('DataSyncer environment', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'infra', 'dataSyncer.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('takes the staging value from stagingSeedUri keyed on the deployed stage', () => {
    expect(source).toContain('STAGING_MONGODB_URI: stagingSeedUri($app.stage, process.env.STAGING_MONGODB_URI),');
  });

  it('never reads the raw variable into the function environment', () => {
    expect(source).not.toMatch(/STAGING_MONGODB_URI:\s*process\.env/);
  });
});
