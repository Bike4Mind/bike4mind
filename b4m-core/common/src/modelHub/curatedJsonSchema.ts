import { z } from 'zod';
import { CuratedCatalogSchema } from '../schemas/modelHub';

export const CURATED_SCHEMA_ID = 'https://app.bike4mind.com/api/model-hub/curated/v2/schema.json';

const DESCRIPTION =
  'Structure of a curated local-model list (schemaVersion 2). This checks shape only: link safety (https on a ' +
  'public host, no credentials), per-entry and per-build consistency, and cross-references (tier picks, families, ' +
  'rankings, unique ids, sequence and changelog) are enforced by the Zod schema when a list is published.';

let cached: string | null = null;

/**
 * The published JSON Schema of a list as authors write it (defaults optional). The app serves this text and
 * catalog/model-hub/schema/curated-v2.schema.json must equal it (`curated:schema --check`).
 */
export function curatedJsonSchemaText(): string {
  if (cached !== null) return cached;
  const generated = z.toJSONSchema(CuratedCatalogSchema, { target: 'draft-2020-12', io: 'input' });
  const { $schema, ...rest } = generated;
  const schema = {
    $schema,
    $id: CURATED_SCHEMA_ID,
    title: 'Bike4Mind curated model list',
    description: DESCRIPTION,
    ...rest,
  };
  cached = `${JSON.stringify(schema, null, 2)}\n`;
  return cached;
}
