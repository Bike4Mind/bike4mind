import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const pinned: string = JSON.parse(read('package.json')).config?.mongodbMemoryServer?.version;

/**
 * Tests, the CI binary cache and the dev compose file must all run one deliberately chosen MongoDB
 * version. The pin lives in the root package.json (read by mongodb-memory-server); the rest follows.
 */
describe('MongoDB version pin', () => {
  it('is an exact x.y.z in the root package.json', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is tagged by major.minor on the compose db image', () => {
    const [major, minor] = pinned.split('.');
    expect(read('compose.yaml')).toMatch(new RegExp(`^\\s+image: mongo:${major}\\.${minor}\\s*$`, 'm'));
  });

  it('keys the CI mongodb-binaries cache on the exported version', () => {
    const keys = read('.github/workflows/ci.yml')
      .split('\n')
      .filter(line => /key: .*-mongodb-binaries-\$\{\{/.test(line));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain('${{ env.MONGOMS_VERSION }}');
    }
  });

  it('exports MONGOMS_VERSION in CI from the root pin', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      `MONGOMS_VERSION=$(node -p "require('./package.json').config.mongodbMemoryServer.version")`
    );
  });
});
