import { describe, expect, it, vi } from 'vitest';
import { curatedLibrary } from '../curated';
import { curatedPick, installedAs, servedLayers } from '../__test__/pullFixtures';
import {
  checkInstalledBlob,
  checkInstalledDigest,
  checkReviewedLayers,
  checkRuntime,
  licensesChanged,
  manifestChange,
} from './checks';

describe('checkRuntime', () => {
  it('refuses an unreachable runtime with its error, curated or not', () => {
    const down = { ok: false, version: null, error: 'connection refused' };
    expect(checkRuntime(down, null)).toEqual({ ok: false, reason: 'runtime-unreachable', error: 'connection refused' });
    expect(checkRuntime(down, curatedPick('library').build)).toMatchObject({ reason: 'runtime-unreachable' });
  });

  it('ignores the version for a build Curated does not pin', () => {
    expect(checkRuntime({ ok: true, version: '0.0.1', error: null }, null)).toEqual({ ok: true });
  });

  it('refuses a curated build the runtime is too old for, and passes a new enough one', () => {
    const { build } = curatedPick('library');
    build.runtimeMin = { ollama: '0.30.0' };
    expect(checkRuntime({ ok: true, version: '0.29.9', error: null }, build)).toEqual({
      ok: false,
      reason: 'runtime-too-old',
      blocked: 'Needs Ollama 0.30.0 or newer',
      required: '0.30.0',
      actual: '0.29.9',
    });
    expect(checkRuntime({ ok: true, version: null, error: null }, build)).toMatchObject({
      reason: 'runtime-too-old',
      actual: null,
    });
    expect(checkRuntime({ ok: true, version: '0.30.0', error: null }, build)).toEqual({ ok: true });
  });
});

describe('checkReviewedLayers', () => {
  const sources = (layers: Parameters<typeof servedLayers>[0] | null) => ({
    libraryLayers: vi.fn(async () => (layers ? servedLayers(layers) : null)),
    hfLayers: vi.fn(async () => (layers ? servedLayers(layers) : null)),
  });

  it('reads a library build from the Ollama library by its ref', async () => {
    const { build } = curatedPick('library');
    const from = sources(build);
    const signal = new AbortController().signal;
    expect(await checkReviewedLayers(build, null, from, signal)).toEqual({ ok: true });
    expect(from.libraryLayers).toHaveBeenCalledWith(curatedLibrary(build)?.ref, { signal });
    expect(from.hfLayers).not.toHaveBeenCalled();
  });

  it('reads a Hugging Face build from its repo at the tag Ollama pulls', async () => {
    const { build } = curatedPick('hf');
    const from = sources(build);
    expect(await checkReviewedLayers(build, 'IQ3_S', from)).toEqual({ ok: true });
    expect(from.hfLayers).toHaveBeenCalledWith(build.hf?.repo, 'IQ3_S', { signal: undefined });
  });

  it('has no source for a Hugging Face build without a tag', async () => {
    const { build } = curatedPick('hf');
    const from = sources(build);
    expect(await checkReviewedLayers(build, null, from)).toEqual({ ok: false, reason: 'layers-no-source' });
    expect(from.hfLayers).not.toHaveBeenCalled();
  });

  it('refuses when the source no longer serves the build, or serves other layers', async () => {
    const { build } = curatedPick('library');
    expect(await checkReviewedLayers(build, null, sources(null))).toEqual({ ok: false, reason: 'layers-not-served' });
    const other = structuredClone(build);
    const library = curatedLibrary(other);
    if (!library) throw new Error('expected a library build');
    library.digest = 'f'.repeat(64);
    expect(await checkReviewedLayers(build, null, sources(other))).toEqual({ ok: false, reason: 'layers-changed' });
  });
});

describe('checkInstalledDigest', () => {
  it('passes the reviewed install without removing anything', async () => {
    const { build } = curatedPick('library');
    const inspection = installedAs(build);
    const remove = vi.fn(async () => {});
    expect(await checkInstalledDigest(inspection, build, { hadTag: false, remove })).toEqual({ ok: true });
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves another install in place unless the tag was definitely absent before', async () => {
    const { build } = curatedPick('library');
    const inspection = installedAs(build);
    if (inspection.contents) inspection.contents.modelBlob = 'f'.repeat(64);
    const remove = vi.fn(async () => {});
    for (const hadTag of [true, null]) {
      expect(await checkInstalledDigest(inspection, build, { hadTag, remove })).toEqual({
        ok: false,
        outcome: 'left-in-place',
        hadTag,
      });
    }
    expect(remove).not.toHaveBeenCalled();
    expect(await checkInstalledDigest(inspection, build, { hadTag: false, remove })).toEqual({
      ok: false,
      outcome: 'removed',
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('reports a removal that failed', async () => {
    const { build } = curatedPick('hf');
    const inspection = installedAs(build);
    if (inspection.contents) inspection.contents.modelBlob = 'f'.repeat(64);
    const remove = vi.fn(async () => {
      throw new Error('busy');
    });
    expect(await checkInstalledDigest(inspection, build, { hadTag: false, remove })).toEqual({
      ok: false,
      outcome: 'remove-failed',
    });
  });
});

describe('checkInstalledBlob', () => {
  const sha = 'a'.repeat(64);
  const installed = (modelBlob: string | null, adapterBlobs: string[] = []) => ({
    ...installedAs(curatedPick('hf').build),
    contents: { template: null, license: null, modelBlob, adapterBlobs },
  });

  it('passes weights with the approved sha256 and nothing layered on them', async () => {
    const remove = vi.fn(async () => {});
    expect(await checkInstalledBlob(installed(sha), sha, { hadTag: false, remove })).toEqual({ ok: true });
    expect(await checkInstalledBlob(installed(sha, ['b'.repeat(64)]), sha, { hadTag: true, remove })).toEqual({
      ok: false,
      outcome: 'left-in-place',
      hadTag: true,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes other weights only when the tag was absent before', async () => {
    const remove = vi.fn(async () => {});
    expect(await checkInstalledBlob(installed('f'.repeat(64)), sha, { hadTag: false, remove })).toEqual({
      ok: false,
      outcome: 'removed',
    });
    expect(await checkInstalledBlob(installed(null), sha, { hadTag: null, remove })).toEqual({
      ok: false,
      outcome: 'left-in-place',
      hadTag: null,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('licensesChanged', () => {
  it('ignores order but not case or count', () => {
    expect(licensesChanged(['mit', 'apache-2.0'], ['apache-2.0', 'mit'])).toBe(false);
    expect(licensesChanged(['mit'], ['MIT'])).toBe(true);
    expect(licensesChanged(['mit'], ['mit', 'mit'])).toBe(true);
    expect(licensesChanged([], [])).toBe(false);
  });
});

describe('manifestChange', () => {
  const shown = { licenses: ['License A'], layers: ['sha256:1', 'sha256:2'] };

  it('is null when nothing changed', () => {
    expect(manifestChange(shown, { licenses: ['License A'], layers: ['sha256:1', 'sha256:2'] })).toBeNull();
  });

  it('names a license text change first, then a layer change, in order', () => {
    expect(manifestChange(shown, { licenses: ['License B'], layers: ['sha256:3'] })).toBe('licenses');
    expect(manifestChange(shown, { licenses: ['License A'], layers: ['sha256:2', 'sha256:1'] })).toBe('layers');
  });
});
