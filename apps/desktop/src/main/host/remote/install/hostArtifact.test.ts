import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostArtifactError, hostArtifactProvider, isHostVersion, readHostArtifact } from './hostArtifact';

let root: string;

/** Writes a tarball and its manifest into `directory`, as scripts/host-artifact.cjs does. */
function writeArtifact(directory: string, version: string, content = `build ${version}`) {
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(content);
  writeFileSync(join(directory, 'b4m-host.tar.gz'), bytes);
  writeFileSync(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      version,
      entry: 'b4m-host.cjs',
      tarball: {
        file: 'b4m-host.tar.gz',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      files: [{ path: 'b4m-host.cjs', size: 10 }],
    })
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'b4m-artifact-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isHostVersion', () => {
  it.each(['1.2.3', '0.2.9-dev.gabc123', '1.0.0-local.0123abc'])('accepts %s', version =>
    expect(isHostVersion(version)).toBe(true)
  );
  it.each(['', '1.2', 'v1.2.3', '1.2.3/..', "1.2.3'", '1.2.3-', '1.2.3-rc.tmp', `1.2.3-${'a'.repeat(64)}`])(
    'refuses %j',
    version => expect(isHostVersion(version)).toBe(false)
  );

  it('agrees with the packing script on every sample', () => {
    const { requireVersion } = createRequire(import.meta.url)('../../../../../scripts/host-artifact.cjs') as {
      requireVersion(version: unknown): string;
    };
    const packs = (version: string): boolean => {
      try {
        requireVersion(version);
        return true;
      } catch {
        return false;
      }
    };
    const samples = [
      '1.2.3',
      '0.2.9-dev.gabc123',
      '1.2',
      '1.2.3-',
      '1.2.3-rc.tmp',
      "1.2.3'",
      `1.2.3-${'a'.repeat(64)}`,
    ];
    for (const version of samples) expect(packs(version), version).toBe(isHostVersion(version));
  });
});

describe('readHostArtifact', () => {
  it('reads an artifact whose manifest matches the app version and the tarball', async () => {
    writeArtifact(root, '1.2.3');
    await expect(readHostArtifact(root, '1.2.3')).resolves.toMatchObject({
      version: '1.2.3',
      tarballPath: join(root, 'b4m-host.tar.gz'),
      size: 11,
    });
  });

  it('refuses an artifact built at another version', async () => {
    writeArtifact(root, '1.2.2');
    await expect(readHostArtifact(root, '1.2.3')).rejects.toThrow('version 1.2.2, not 1.2.3');
  });

  it('refuses a tarball that does not match its manifest', async () => {
    writeArtifact(root, '1.2.3');
    writeFileSync(join(root, 'b4m-host.tar.gz'), 'build 1.2.4');
    await expect(readHostArtifact(root, '1.2.3')).rejects.toThrow('does not match its manifest');
  });

  it('refuses a missing or malformed manifest', async () => {
    await expect(readHostArtifact(root, '1.2.3')).rejects.toBeInstanceOf(HostArtifactError);
    writeFileSync(join(root, 'manifest.json'), '{"schema":2}');
    await expect(readHostArtifact(root, '1.2.3')).rejects.toThrow('not a host program manifest');
  });
});

describe('hostArtifactProvider', () => {
  it('reads a packaged app artifact from its resources once', async () => {
    writeArtifact(join(root, 'host'), '1.2.3');
    const provide = hostArtifactProvider({ packaged: true, resourcesPath: root }, '1.2.3');
    const first = await provide();
    rmSync(join(root, 'host'), { recursive: true });
    await expect(provide()).resolves.toBe(first);
  });

  it('tries a failed packaged read again', async () => {
    const provide = hostArtifactProvider({ packaged: true, resourcesPath: root }, '1.2.3');
    await expect(provide()).rejects.toBeInstanceOf(HostArtifactError);
    writeArtifact(join(root, 'host'), '1.2.3');
    await expect(provide()).resolves.toMatchObject({ version: '1.2.3' });
  });

  it('builds a source run artifact at the run version, one build at a time', async () => {
    let builds = 0;
    const build = vi.fn(async (version: string) => {
      builds += 1;
      writeArtifact(join(root, 'out', 'host-artifact'), version, `build ${version} #${builds}`);
    });
    const provide = hostArtifactProvider({ packaged: false, appPath: root, build }, '0.2.9-dev.gabc');

    const [first, second] = await Promise.all([provide(), provide()]);
    expect(first).toBe(second);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('0.2.9-dev.gabc');

    await provide();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when the source run build fails', async () => {
    const build = vi.fn(async () => {
      throw new HostArtifactError('Building the host program failed (exit 1): boom');
    });
    const provide = hostArtifactProvider({ packaged: false, appPath: root, build }, '1.2.3');
    await expect(provide()).rejects.toThrow('boom');
    await expect(provide()).rejects.toThrow('boom');
    expect(build).toHaveBeenCalledTimes(2);
  });
});
