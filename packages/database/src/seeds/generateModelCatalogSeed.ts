import {
  AnthropicBackend,
  AWSBackend,
  BFLBackend,
  GeminiBackend,
  OpenAIBackend,
  UndifferentiatedBedrockBackend,
  XAIBackend,
} from '@bike4mind/llm-adapters';
import { groupsTouchedByPatch, toModelRecord } from '@bike4mind/common';
import type { FieldGroup, ModelInfo, ModelRecord } from '@bike4mind/common';

export interface ModelCatalogSeedEntry {
  modelId: string;
  /** Groups this row claims authority over: exactly what the patch touches. */
  ownedGroups: FieldGroup[];
  patch: ModelRecord;
}

/** The catalog's own date shape; anything else cannot be appended (see ModelCatalogTypes). */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Models from every backend whose getModelInfo() is a static table (no network,
 * no real key needed). Ollama and LocalImage are excluded for the same reason
 * the price seed excludes Ollama: their lists are live server calls, so they are
 * discovered per request and never belong in a checked-in fallback.
 *
 * Unlike the price seed this keeps every type, not just text: the catalog is the
 * availability record for image, speech-to-text and video models too.
 */
export async function collectStaticCatalogModels(): Promise<ModelInfo[]> {
  const backends = [
    new OpenAIBackend('seed-key'),
    new AnthropicBackend('seed-key'),
    new UndifferentiatedBedrockBackend(),
    new GeminiBackend('seed-key'),
    new XAIBackend('seed-key'),
    new AWSBackend(),
    new BFLBackend('seed-key'),
  ];
  return (await Promise.all(backends.map(b => b.getModelInfo()))).flat();
}

/**
 * The seed derives from the adapter tables, so at generation time the catalog
 * and the literals agree by construction. The checked-in modelCatalog.seed.json
 * is the reviewed audit of the fallback tier; the freshness test fails when an
 * adapter table changes without regenerating it.
 *
 * Deprecated models are kept: a retired model's row is what makes historical
 * sessions and pinned ids still readable, and the seeded lifecycle is what
 * reproduces today's deprecation filtering on a fresh database.
 */
export async function generateModelCatalogSeed(): Promise<ModelCatalogSeedEntry[]> {
  const models = await collectStaticCatalogModels();
  const entries: ModelCatalogSeedEntry[] = [];
  const seen = new Set<string>();
  const droppedDates: string[] = [];

  for (const model of models) {
    const modelId = String(model.id);
    // One row per model per effectiveFrom is a unique index; an id listed by two
    // adapter tables must not become two identical appends.
    if (seen.has(modelId)) continue;
    seen.add(modelId);

    const patch = compact(toModelRecord(model), modelId, droppedDates);
    entries.push({
      modelId,
      ownedGroups: groupsTouchedByPatch(patch as unknown as Record<string, unknown>),
      patch,
    });
  }

  if (droppedDates.length > 0) {
    // Loud rather than silent: the field is gone from the fallback tier until
    // the adapter literal is corrected to a full calendar date.
    console.warn(
      `[modelCatalog] seed dropped ${droppedDates.length} date field(s) that are not YYYY-MM-DD: ${droppedDates.join(', ')}`
    );
  }

  return entries.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Drop undefined keys (so the generated entry equals the checked-in JSON
 * exactly) and any date the append schema would reject.
 */
function compact(record: ModelRecord, modelId: string, droppedDates: string[]): ModelRecord {
  const cleaned = JSON.parse(JSON.stringify(record)) as ModelRecord;

  for (const field of ['trainingCutoff', 'releaseDate'] as const) {
    const value = cleaned[field];
    if (value !== undefined && !CALENDAR_DATE.test(value)) {
      droppedDates.push(`${modelId}.${field}`);
      delete cleaned[field];
    }
  }
  const deprecationDate = cleaned.lifecycle?.deprecationDate;
  if (deprecationDate !== undefined && !CALENDAR_DATE.test(deprecationDate)) {
    droppedDates.push(`${modelId}.lifecycle.deprecationDate`);
    delete cleaned.lifecycle?.deprecationDate;
  }

  return cleaned;
}
