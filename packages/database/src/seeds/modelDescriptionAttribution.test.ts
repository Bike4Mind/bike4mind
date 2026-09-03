import { describe, it, expect } from 'vitest';
import { collectStaticCatalogModels } from './generateModelCatalogSeed';

/**
 * Every adapter table writes descriptions as '<Model Name> - <sentence>'. A description
 * shifted onto the neighbouring entry therefore still reads as a plausible model blurb,
 * which is why it shipped unnoticed on two FLUX rows: the picker showed another model's
 * text, and the picker's description search (ModelSelection.tsx) matched the wrong model.
 *
 * Held over the whole static catalog rather than one backend, since nothing about the
 * failure is BFL-specific. Compares NAMES, not ids: the direct-API and Bedrock variants
 * of a Claude model share a display name, so resolving a leading name to an id would
 * report a Bedrock row leading with its own name as if it described its twin.
 */
describe('static model catalog description attribution', () => {
  it('never leads a description with another model name', async () => {
    const models = await collectStaticCatalogModels();
    const names = new Set(models.map(model => model.name).filter(Boolean));

    const misattributed = models.flatMap(model => {
      const description = model.description ?? '';
      const separator = description.indexOf(' - ');
      // No separator means the description does not use the naming convention at all;
      // there is no leading name to misattribute. Exact equality keeps this at zero
      // false positives: a prefix that merely CONTAINS a model name (a vendor-prefixed
      // blurb) is not a claim about that model.
      if (separator < 0) return [];
      const leadsWith = description.slice(0, separator).trim();
      if (!names.has(leadsWith) || leadsWith === model.name) return [];
      return [{ id: model.id, name: model.name, leadsWith }];
    });

    expect(misattributed).toEqual([]);
  });
});
