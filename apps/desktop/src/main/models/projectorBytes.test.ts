import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCuratedManifest } from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unifiedMachine } from '../chat/fitStub.testHelper';
import { HardwareProbe, localContextSizing } from '../chat/localContextSizing';
import { installedProjectorBytes, pinnedProjectorSizes } from './projectorBytes';

const digest = (n: number) => String(n).repeat(64);

describe('installedProjectorBytes', () => {
  let storeDir: string;
  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'b4m-store-'));
    await mkdir(join(storeDir, 'blobs'));
    for (const [n, size] of [
      [1, 1000],
      [2, 2500],
    ]) {
      const blob = join(storeDir, 'blobs', `sha256-${digest(n)}`);
      await writeFile(blob, '');
      await truncate(blob, size);
    }
  });
  afterEach(() => rm(storeDir, { recursive: true, force: true }));

  it("reads this computer's projector blobs from the model folder", async () => {
    expect(await installedProjectorBytes({ projectorBlobs: [digest(1), digest(2)], storeDir })).toBe(3500);
    expect(await installedProjectorBytes({ projectorBlobs: [], storeDir })).toBe(0);
  });

  it('counts none unless every projector size is known', async () => {
    expect(await installedProjectorBytes({ projectorBlobs: [digest(1), digest(3)], storeDir })).toBe(0);
    expect(await installedProjectorBytes({ projectorBlobs: [digest(1), null], storeDir })).toBe(0);
    expect(await installedProjectorBytes({ projectorBlobs: [digest(1)], storeDir: null })).toBe(0);
    expect(await installedProjectorBytes(undefined)).toBe(0);
  });

  it("looks a saved server's projectors up in the pins and never reads this computer's disk for them", async () => {
    const pinned = new Map([[digest(3), 4000]]);
    expect(await installedProjectorBytes({ projectorBlobs: [digest(3)], storeDir }, pinned)).toBe(4000);
    expect(await installedProjectorBytes({ projectorBlobs: [digest(1)], storeDir }, pinned)).toBe(0);
  });

  it("sizes chat's projector from the Modelfile Ollama shows", async () => {
    const modelfile = `FROM ${join(storeDir, 'blobs', `sha256-${digest(9)}`)}\nFROM ${join(storeDir, 'blobs', `sha256-${digest(2)}`)}\n`;
    const sizing = localContextSizing({
      setting: async () => AUTO_LOCAL_CONTEXT,
      hardware: new HardwareProbe(async () => unifiedMachine(16)),
    });
    const footprint = await sizing.footprint({ name: 'vision', modelfile, sizeBytes: 5e9, digest: 'one' });
    expect(footprint.projectorBytes).toBe(2500);
    expect(sizing.cachedFootprint({ name: 'vision', modelfile, sizeBytes: 5e9, digest: 'one' }).projectorBytes).toBe(
      2500
    );
  });
});

describe('pinnedProjectorSizes', () => {
  it('maps every pinned projector in the bundled list to its size', () => {
    const sizes = pinnedProjectorSizes(loadCuratedManifest(() => {}));
    // Gemma 4 12B's library projector, read from the blob Ollama stores under that digest.
    expect(sizes.get('e70b0e5cd80323d5d588b4ed06780356b7b1ba03995a4b8164c6ae9db0ff5989')).toBe(175_115_264);
    expect(sizes.get('13cb7bebccbd04afc8f4090cb949ecf8937cdf7377c5799b1a0c594e7c0d3e16')).toBe(931_146_528);
  });
});
