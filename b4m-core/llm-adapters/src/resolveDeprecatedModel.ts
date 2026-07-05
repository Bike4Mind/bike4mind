import { Logger } from '@bike4mind/observability';
/**
 * Runtime safety net for deprecated model IDs.
 *
 * When a model ID stored in the database or passed from a user session
 * references a deprecated/retired model, this resolver maps it to the
 * closest modern equivalent so the request doesn't fail at the API layer.
 *
 * The console.warn produces a CloudWatch-searchable `[model-sunset]` signal.
 */

const DEPRECATED_MODEL_MAP: Record<string, string> = {
  // Bedrock models
  'anthropic.claude-3-5-sonnet-20240620-v1:0': 'global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-3-opus-20240229-v1:0': 'global.anthropic.claude-opus-4-8',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': 'global.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-3-7-sonnet-20250219-v1:0': 'global.anthropic.claude-sonnet-4-6',
  'anthropic.claude-3-haiku-20240307-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Anthropic-hosted models
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  'claude-3-opus-20240229': 'claude-opus-4-8',
  'claude-3-haiku-20240307': 'claude-haiku-4-5-20251001',
};

export function resolveDeprecatedModelId(modelId: string, context?: string): string {
  const resolved = DEPRECATED_MODEL_MAP[modelId];
  if (resolved) {
    Logger.globalInstance.warn(
      `[model-sunset] Resolved deprecated model: ${modelId} → ${resolved} (context: ${context ?? 'unknown'})`
    );
    return resolved;
  }
  return modelId;
}
