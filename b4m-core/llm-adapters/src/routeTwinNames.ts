import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

// Must stay in sync with BEDROCK_PROFILE_PREFIX in apps/client/app/utils/pickerModelDedupe.ts.
const BEDROCK_PROFILE_PREFIX = /^(global|us-gov|us|eu|apac|jp|au|ca)\./;
const BEDROCK_VERSION_SUFFIX = /-v\d+(?::\d+)?$/;

/**
 * The direct-API id a Bedrock id serves: `global.anthropic.claude-haiku-5-5` -> `claude-haiku-5-5`,
 * `us.anthropic.claude-3-5-sonnet-20241022-v2:0` -> `claude-3-5-sonnet-20241022`. Null for any
 * other backend. The result is only a candidate; callers match it against real ids.
 */
export function directTwinId(model: Pick<ModelInfo, 'id' | 'backend'>): string | null {
  if (model.backend !== ModelBackend.Bedrock) return null;
  const withoutProfile = String(model.id).replace(BEDROCK_PROFILE_PREFIX, '');
  const vendorDot = withoutProfile.indexOf('.');
  if (vendorDot < 0) return null;
  return withoutProfile.slice(vendorDot + 1).replace(BEDROCK_VERSION_SUFFIX, '');
}

let staticDirectNames: Promise<Map<string, string>> | null = null;

// The adapter literal names direct models for a caller with no Anthropic key, whose list has no twin.
function getStaticDirectNames(): Promise<Map<string, string>> {
  staticDirectNames ??= new AnthropicBackend('static-listing')
    .getModelInfo()
    .then(models => new Map(models.map(m => [String(m.id), m.name])));
  return staticDirectNames;
}

/**
 * Gives every Bedrock route of a model the display name of its direct-API twin, so one model reads
 * one way in the picker, chat headers and usage. The twin's name is the merged one when the caller
 * lists it (catalog and operator renames included), else the adapter literal. Without this, a
 * discovery row naming the Bedrock id after AWS's listing ("Claude 5.5 Haiku") outranks the seed
 * name for that id alone.
 */
export async function alignRouteTwinNames(models: ModelInfo[]): Promise<ModelInfo[]> {
  if (!models.some(m => m.backend === ModelBackend.Bedrock)) return models;

  const listedNames = new Map(models.filter(m => m.backend !== ModelBackend.Bedrock).map(m => [String(m.id), m.name]));
  const staticNames = await getStaticDirectNames();

  return models.map(model => {
    const twinId = directTwinId(model);
    if (!twinId) return model;
    const twinName = listedNames.get(twinId) ?? staticNames.get(twinId);
    return twinName && twinName !== model.name ? { ...model, name: twinName } : model;
  });
}
