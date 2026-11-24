/**
 * @vitest-environment node
 *
 * The gate is imported directly; its call sites are text-matched because infra/ is an SST program
 * and does not load outside `sst`. That every reader handles the undefined a preview gets is left to
 * the strict infra typecheck (`pnpm typecheck:infra`), since the return type carries it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PREVIEW_SKIPPED_QUEUE_CONSUMERS, subscribeUnlessPreview } from '../previewQueueConsumers';

const INFRA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(INFRA, file), 'utf8');
const infraSources = readdirSync(INFRA)
  .filter(file => file.endsWith('.ts') && file !== 'previewQueueConsumers.ts')
  .map(file => ({ file, source: read(file) }));

// Mirrors the isPreviewStage expression in infra/constants.ts, minus the IS_PREVIEW env override.
const isPreviewStageName = (stage: string) => /^pr\d+$/.test(stage);

describe('subscribeUnlessPreview', () => {
  it.each(['production', 'dev', 'personal-stage'])('creates every consumer on stage %s', stage => {
    for (const queue of PREVIEW_SKIPPED_QUEUE_CONSUMERS) {
      const subscription = { queue };
      const subscribe = vi.fn((...args: unknown[]) => ({ ...subscription, args }));
      expect(subscribeUnlessPreview(isPreviewStageName(stage), queue, { subscribe }, 'handler', { batch: 1 })).toEqual({
        ...subscription,
        args: ['handler', { batch: 1 }],
      });
      expect(subscribe).toHaveBeenCalledOnce();
    }
  });

  it('creates none of them on a preview stage', () => {
    for (const queue of PREVIEW_SKIPPED_QUEUE_CONSUMERS) {
      const subscribe = vi.fn();
      expect(subscribeUnlessPreview(isPreviewStageName('pr1234'), queue, { subscribe }, 'handler')).toBeUndefined();
      expect(subscribe).not.toHaveBeenCalled();
    }
  });

  it('keys off the same preview test as infra/constants.ts', () => {
    expect(read('constants.ts')).toContain('/^pr\\d+$/.test($app.stage)');
  });
});

describe('preview-skipped call sites', () => {
  const callSites = infraSources.flatMap(({ file, source }) =>
    [...source.matchAll(/subscribeUnlessPreview\(\s*(\w+),\s*'([^']+)',\s*(\w+),/g)].map(
      ([, gate, name, receiver]) => ({
        file,
        gate,
        name,
        receiver,
      })
    )
  );

  it('gates exactly the listed queues, once each, on the queue it names', () => {
    expect(callSites.map(site => site.name).sort()).toEqual([...PREVIEW_SKIPPED_QUEUE_CONSUMERS].sort());
    for (const site of callSites) {
      expect(site.gate).toBe('isPreviewStage');
      expect(site.receiver).toBe(site.name);
    }
  });

  it('has no call site the pattern above missed', () => {
    const total = infraSources.reduce(
      (count, { source }) => count + (source.match(/subscribeUnlessPreview\(/g)?.length ?? 0),
      0
    );
    expect(total).toBe(callSites.length);
  });

  // The tester flows (chat and agents, file upload and ingest, image and Studio generation, data
  // lakes, login) depend on these consumers on a preview.
  it.each([
    'fabFileChunkQueue',
    'fabFileVectorizeQueue',
    'imageGenerationQueue',
    'imageEditQueue',
    'generationCallbackQueue',
    'generationJobQueue',
    'agentContinuationQueue',
    'dataLakeTaxonomyQueue',
    'riskEvidenceQueue',
  ])('keeps the %s consumer on previews', queue => {
    expect(PREVIEW_SKIPPED_QUEUE_CONSUMERS).not.toContain(queue);
  });
});
