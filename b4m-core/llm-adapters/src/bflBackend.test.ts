import { describe, it, expect } from 'vitest';
import { ImageModels } from '@bike4mind/common';
import { BFLBackend } from './bflBackend';

describe('BFLBackend.getModelInfo', () => {
  it('never leads a description with another model name', async () => {
    // The catalog seed and every picker surface read these strings verbatim, and a
    // description shifted onto the neighbouring entry reads as a plausible blurb
    // rather than as a bug - it also makes the picker's description search
    // (ModelSelection.tsx) match the wrong model. Asserting the leading
    // '<Model Name> - ' segment names its own row is what catches the shift.
    // The same rule holds across collectStaticCatalogModels() if it is ever wanted
    // catalog-wide; scoped here to keep this a table-only unit test.
    const models = await new BFLBackend('test-key').getModelInfo();
    const owners = new Map(models.map(model => [model.name, model.id]));

    const misattributed = models.flatMap(model => {
      const [prefix] = (model.description ?? '').split(' - ', 1);
      const owner = owners.get(prefix.trim());
      return owner && owner !== model.id ? [{ id: model.id, describes: owner }] : [];
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
