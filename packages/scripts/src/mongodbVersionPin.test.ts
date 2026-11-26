import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const pinned: string | undefined = JSON.parse(read('package.json')).config?.mongodbMemoryServer?.version;

/**
 * Tests, the CI binary cache and the dev compose file must all run one deliberately chosen MongoDB
 * version. The pin lives in the root package.json (read by mongodb-memory-server); the rest follows.
 */
describe('MongoDB version pin', () => {
  it('is an exact x.y.z in the root package.json', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is tagged by major.minor on the compose db image', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = (pinned as string).split('.');
    expect(read('compose.yaml')).toMatch(new RegExp(`^\\s+image: mongo:${major}\\.${minor}\\s*$`, 'm'));
  });

  it('keys the CI mongodb-binaries cache and its restore-keys on the exported version', () => {
    const lines = read('.github/workflows/ci.yml')
      .split('\n')
      .filter(line => !line.trim().startsWith('#') && line.includes('-mongodb-binaries-'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain('${{ env.MONGOMS_VERSION }}');
    }
  });

  it('exports a validated MONGOMS_VERSION in CI from the root pin', () => {
    const lines = read('.github/workflows/ci.yml')
      .split('\n')
      .map(line => line.trim())
      .filter(line => !line.startsWith('#'));
    // Separate lines on purpose: under `bash -e`, a failure on the left of `&&` does not abort.
    const at = lines.indexOf(`v=$(node -p "require('./package.json').config?.mongodbMemoryServer?.version ?? ''")`);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('[[ "$v" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(lines).toContain('echo "MONGOMS_VERSION=$v" >> "$GITHUB_ENV"');
  });
});
