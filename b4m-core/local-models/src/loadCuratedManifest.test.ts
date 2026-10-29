import { HubManifestSchema, parseHubManifest, type HubBuild } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import bundled from '../../../catalog/model-hub/curated-v2.json';
import { isAbliteratedModel } from './abliterated';
import { curatedOllamaBlocked, loadCuratedManifest } from './curated';

const SHA256 = /^[0-9a-f]{64}$/;
const strict = () => HubManifestSchema.parse(bundled);
const pins = (build: HubBuild) =>
  build.ollama?.kind === 'library' || build.ollama?.kind === 'hf-pull' ? build.ollama.layers : undefined;

describe('the bundled curated list', () => {
  it('passes the hub manifest schema whole, so the reader drops nothing', () => {
    expect(() => strict()).not.toThrow();
    expect(parseHubManifest(bundled).dropped).toEqual([]);
  });

  it('records every entry in a changelog item no newer than the list', () => {
    const manifest = strict();
    expect(manifest.changelog[0].sequence).toBe(manifest.sequence);
    expect(manifest.updatedAt.startsWith(manifest.changelog[0].date)).toBe(true);
    const recorded = manifest.changelog.flatMap(item => [...item.added, ...item.changed]);
    for (const entry of manifest.entries) expect(recorded, entry.id).toContain(entry.id);
  });

  it('lists no abliterated build and only permissive licenses', () => {
    for (const entry of strict().entries) {
      expect(entry.flags.abliterated, entry.id).toBe(false);
      expect(entry.lineage.variantType, entry.id).not.toBe('abliterated');
      expect([entry.license.class, entry.license.base.class], entry.id).toEqual(['permissive', 'permissive']);
      expect(isAbliteratedModel({ id: entry.lineage.base }), entry.id).toBe(false);
    }
  });

  // A build without these pins is never offered, so a missing one would silently empty its slot.
  it('pins the weights of every build, the template of every hf.co build, and a floor Ollama version', () => {
    for (const entry of strict().entries)
      for (const build of entry.builds) {
        const layers = pins(build);
        const label = `${entry.id} ${build.id}`;
        const library = build.ollama?.kind === 'library';
        expect(layers, label).toBeDefined();
        // A library build chats through an Ollama renderer; /api/show then reports a placeholder template.
        if (library) expect(layers?.installedTemplate, label).toBeUndefined();
        else expect(layers?.installedTemplate ?? layers?.template, label).toMatch(SHA256);
        const weights = build.ollama?.kind === 'library' ? build.ollama.digest : build.weights[0]?.sha256;
        expect(weights, label).toMatch(SHA256);
        expect(build.runtimeMin?.ollama, label).toMatch(/^\d+\.\d+\.\d+$/);
      }
  });

  // Ollama before 0.30.0 leaves the draft out of /api/show, so the post-pull check would delete the model.
  it('needs an Ollama that shows the draft for every build that pins one', () => {
    const drafted = strict().entries.flatMap(entry => entry.builds.filter(build => pins(build)?.draft));
    expect(drafted.length).toBeGreaterThan(0);
    for (const build of drafted) {
      expect(curatedOllamaBlocked(build, '0.24.0'), build.id).not.toBeNull();
      expect(curatedOllamaBlocked(build, '0.30.0'), build.id).toBeNull();
    }
  });

  it('declares vision and tools on every pick', () => {
    for (const entry of strict().entries)
      expect(entry.capabilities, entry.id).toMatchObject({ vision: true, tools: true });
  });
});

describe('loadCuratedManifest', () => {
  it('reads the bundled list without a warning', () => {
    const warn = vi.fn();
    expect(loadCuratedManifest(warn).entries).toHaveLength(strict().entries.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the readable entries and names what it dropped', () => {
    const warn = vi.fn();
    const input = structuredClone(bundled) as { entries: unknown[] };
    input.entries[0] = { id: 'broken' };
    const manifest = loadCuratedManifest(warn, input);

    expect(manifest.entries).toHaveLength(strict().entries.length - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^MODELS: curated list dropped \d+ item\(s\): entries\.0/));
  });

  it.each([
    ['not an object', 'nope'],
    ['the wrong schema version', { ...bundled, schemaVersion: 1 }],
    ['missing its entries', { ...bundled, entries: undefined }],
  ])('falls back to the bundled list for input that is %s', (_label, input) => {
    const warn = vi.fn();
    const manifest = loadCuratedManifest(warn, input);
    expect(manifest).toEqual(parseHubManifest(bundled).manifest);
    expect(manifest.tiers.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('MODELS: curated list unreadable, showing the bundled one')
    );
  });
});
