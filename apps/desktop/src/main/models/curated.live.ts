import {
  HuggingFaceHub,
  OllamaRuntime,
  curatedOllamaBlocked,
  installedReviewed,
  ollamaLibraryLayers,
  servesReviewed,
} from '@bike4mind/local-models';
import { HubManifestSchema } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import bundled from '../../../../../catalog/model-hub/curated-v2.json';

// Registry-only by default. Pull mode downloads weights but never removes or rewrites catalog pins.
const mode = z.enum(['registry', 'installed', 'pull']).parse(process.env.CURATED_CHECK ?? 'registry');
const manifest = HubManifestSchema.parse(bundled);
const hub = new HuggingFaceHub();
const runtime = new OllamaRuntime();
const selected = process.env.CURATED_BUILD;
const builds = manifest.entries.flatMap(entry =>
  entry.builds.map(build => ({ entry, build, id: `${entry.id}/${build.id}` }))
);
const checked = builds.filter(({ id }) => !selected || selected === id);
if (!checked.length) throw new Error(`No curated build matches ${selected}`);

describe.sequential(`bundled curated builds (${mode})`, () => {
  for (const { build, id } of checked) {
    it(id, async () => {
      const source = build.ollama;
      if (!source || (source.kind !== 'library' && source.kind !== 'hf-pull'))
        throw new Error(`${id} has no registry source`);
      let ref: string;
      if (source.kind === 'library') ref = source.ref;
      else {
        if (!build.hf) throw new Error(`${id} has no Hugging Face repo`);
        const detail = await hub.getModel(build.hf.repo);
        const live = detail.builds.find(candidate => candidate.files[0]?.sha256 === build.weights[0]?.sha256);
        if (!live) throw new Error(`${id}: reviewed weights no longer listed`);
        const verified = await hub.verifyOllamaRef(detail, live);
        if (!verified) throw new Error(`${id}: registry cannot serve the reviewed file`);
        ref = verified;
      }
      const repo = build.hf?.repo;
      if (source.kind === 'hf-pull' && !repo) throw new Error(`${id} has no Hugging Face repo`);
      const layers =
        source.kind === 'library'
          ? await ollamaLibraryLayers(ref)
          : await hub.ollamaLayers(repo ?? '', ref.slice(ref.lastIndexOf(':') + 1));
      expect(layers, `${id}: registry tag missing`).not.toBeNull();
      expect(layers && servesReviewed(layers, build), `${id}: registry pins changed`).toBe(true);
      if (mode === 'registry') return;

      const health = await runtime.health();
      expect(health.ok, health.error ?? 'Ollama is unavailable').toBe(true);
      expect(curatedOllamaBlocked(build, health.version), `${id}: unsupported Ollama version`).toBeNull();
      console.info(`${id}: Ollama ${health.version}; declared minimum ${build.runtimeMin?.ollama}; ref ${ref}`);
      if (mode === 'pull') await runtime.pull(ref, source.kind === 'library' ? { runner: 'llamacpp' } : {});
      const inspection = await runtime.inspect(ref, { tags: false, timeoutMs: 30_000 });
      expect(installedReviewed(inspection, build), `${id}: /api/show differs from reviewed contents`).toBe(true);
    });
  }
});
