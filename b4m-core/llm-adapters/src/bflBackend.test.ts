import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { BFLBackend } from './bflBackend';

describe('BFLBackend.getModelInfo', () => {
  it('never leads a description with another model name', async () => {
    // Kept alongside the table it guards even though
    // packages/database/src/seeds/modelDescriptionAttribution.test.ts holds the same
    // invariant over every backend: that one reads the BUILT adapter dist, so it cannot
    // fail on a source edit here until the package is rebuilt. This is the fast local
    // signal; that one is the coverage.
    const models = await new BFLBackend('test-key').getModelInfo();
    const names = new Set(models.map(model => model.name).filter(Boolean));

    const misattributed = models.flatMap(model => {
      const description = model.description ?? '';
      const separator = description.indexOf(' - ');
      if (separator < 0) return [];
      const leadsWith = description.slice(0, separator).trim();
      if (!names.has(leadsWith) || leadsWith === model.name) return [];
      return [{ id: model.id, name: model.name, leadsWith }];
    });

    expect(misattributed).toEqual([]);
  });

  it('describes each FLUX entry as itself', async () => {
    const models = await new BFLBackend('test-key').getModelInfo();
    const descriptionOf = (id: string) => models.find(model => model.id === id)?.description;

    expect(descriptionOf(ImageModels.FLUX_PRO_1_1)).toMatch(/^FLUX Pro 1\.1 - /);
    expect(descriptionOf(ImageModels.FLUX_KONTEXT_PRO)).toMatch(/^FLUX Kontext Pro - /);
    expect(descriptionOf(ImageModels.FLUX_KONTEXT_MAX)).toMatch(/^FLUX Kontext Max - /);
  });
});
