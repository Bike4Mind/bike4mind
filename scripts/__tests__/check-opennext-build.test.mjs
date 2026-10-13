import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOpenNextVersion,
  openNextBuildCommand,
  bundleSize,
  lambdaBundles,
  hasDefaultBundle,
  findOversized,
  LAMBDA_UNZIPPED_LIMIT_BYTES,
} from '../check-opennext-build.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('parseOpenNextVersion', () => {
  it('reads the pinned version out of infra/web.ts', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'infra/web.ts'), 'utf8');
    expect(parseOpenNextVersion(source)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('throws when the pin is missing or not a literal', () => {
    expect(() => parseOpenNextVersion('new sst.aws.Nextjs("x", {})')).toThrow(/found 0/);
    expect(() => parseOpenNextVersion('openNextVersion: OPEN_NEXT,')).toThrow(/found 0/);
  });

  it('throws when there is more than one pin to choose from', () => {
    expect(() => parseOpenNextVersion("openNextVersion: '4.1.8',\nopenNextVersion: '4.1.9',")).toThrow(/found 2/);
  });
});

describe('openNextBuildCommand', () => {
  it('uses the @opennextjs/aws package name after 3.1.3, as sst does', () => {
    expect(openNextBuildCommand('4.1.8')).toBe('npx --yes @opennextjs/aws@4.1.8 build');
    expect(openNextBuildCommand('3.1.4')).toBe('npx --yes @opennextjs/aws@3.1.4 build');
    expect(openNextBuildCommand('3.1.3')).toBe('npx --yes open-next@3.1.3 build');
  });

  it('rejects anything that is not an exact version', () => {
    expect(() => openNextBuildCommand('^4.1.8')).toThrow(/exact/);
    expect(() => openNextBuildCommand('latest')).toThrow(/exact/);
  });
});

describe('bundleSize', () => {
  it('counts file bytes, follows file symlinks, and reports skipped directory and dangling links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opennext-size-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'bundle/nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'bundle/a.js'), 'x'.repeat(100));
    fs.writeFileSync(path.join(root, 'bundle/nested/b.js'), 'x'.repeat(50));
    fs.writeFileSync(path.join(root, 'outside/c.js'), 'x'.repeat(1000));
    fs.symlinkSync(path.join(root, 'outside/c.js'), path.join(root, 'bundle/c.js'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'bundle/linked-dir'));
    fs.symlinkSync(path.join(root, 'outside/missing.js'), path.join(root, 'bundle/dangling.js'));

    expect(bundleSize(path.join(root, 'bundle'))).toEqual({ bytes: 1150, files: 3, directoryLinks: 1, brokenLinks: 1 });
  });
});

describe('hasDefaultBundle', () => {
  it('requires the server function bundle, not just any bundle', () => {
    expect(hasDefaultBundle([{ name: 'default', bundle: 'a' }])).toBe(true);
    expect(hasDefaultBundle([{ name: 'imageOptimizer', bundle: 'b' }])).toBe(false);
    expect(hasDefaultBundle([])).toBe(false);
  });
});

describe('findOversized', () => {
  it('treats exactly the limit as fitting and one byte over as oversized', () => {
    const sizes = [
      { name: 'atLimit', bytes: LAMBDA_UNZIPPED_LIMIT_BYTES },
      { name: 'overByOne', bytes: LAMBDA_UNZIPPED_LIMIT_BYTES + 1 },
      { name: 'small', bytes: 1 },
    ];
    expect(findOversized(sizes).map(size => size.name)).toEqual(['overByOne']);
  });

  it('uses the 250 MiB Lambda limit by default and accepts an override', () => {
    expect(LAMBDA_UNZIPPED_LIMIT_BYTES).toBe(250 * 1024 * 1024);
    expect(findOversized([{ name: 'x', bytes: 11 }], 10)).toHaveLength(1);
  });
});

describe('lambdaBundles', () => {
  it('lists every origin and additional function that ships a bundle', () => {
    const output = {
      origins: {
        s3: { type: 's3', originPath: '_assets' },
        default: { type: 'function', bundle: '.open-next/server-functions/default' },
        imageOptimizer: { type: 'function', bundle: '.open-next/image-optimization-function' },
      },
      additionalProps: {
        disableIncrementalCache: false,
        revalidationFunction: { bundle: '.open-next/revalidation-function' },
      },
    };
    expect(lambdaBundles(output).map(b => b.name)).toEqual(['default', 'imageOptimizer', 'revalidationFunction']);
  });
});
