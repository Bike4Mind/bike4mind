import { Logger } from '@bike4mind/observability';
/**
 * Runtime safety net for deprecated model IDs.
 *
 * When a model ID stored in the database or passed from a user session
 * references a deprecated/retired model, this resolver maps it to the
 * closest modern equivalent.
 *
 * Entry criterion is "superseded within its backend family", NOT "404s
 * upstream". A model that hard-fails is a loud, self-reporting bug someone
 * fixes within the hour; a model that still resolves but is generations stale
 * is a SILENT one, because a user cannot tell an obsolete model from a bad
 * product and so never reports it. The second failure mode is the more
 * damaging one, so both belong here.
 *
 * Invariant: every catalog entry carrying a `deprecationDate` must have a
 * mapping here, enforced by a test in resolveDeprecatedModel.test.ts. A model
 * hidden from the picker is still reachable through a session's pinned
 * `lastUsedModel`, so hiding it without mapping it strands existing sessions.
 *
 * Mappings must not silently raise a user's cost. Where the modern equivalent
 * is more expensive than what the user chose, prefer the cheapest CURRENT
 * model that preserves the original's intent (see grok-3-mini-fast below).
 *
 * The warn produces a CloudWatch-searchable `[model-sunset]` signal.
 */

// Exported so tests can enforce the deprecationDate <-> mapping invariant described above.
export const DEPRECATED_MODEL_MAP: Record<string, string> = {
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
  // OpenAI-hosted models retired from the API (https://platform.openai.com/docs/deprecations).
  // These are past their shutdown date and 404 upstream, so a session/agent still pinned to
  // one must be upgraded here to avoid a hard API failure.
  'gpt-5-chat-latest': 'gpt-5.5',
  'gpt-5.1-chat-latest': 'gpt-5.5',
  // xAI models superseded by Grok 4.5. These all still resolve upstream, so nothing here
  // prevents an API failure -- they are mapped because Grok 4.5 is cheaper AND strictly more
  // capable (reasoning, vision, 500K context, cache reads) than every one of them. Grok 3 in
  // particular has can_think:false and supportsVision:false at $3/$15 per 1M, against Grok
  // 4.5's $2/$6, so leaving a session pinned to it costs the user more for a worse answer.
  'grok-3': 'grok-4.5',
  'grok-3-fast': 'grok-4.5',
  'grok-2-1212': 'grok-4.5',
  'grok-2-vision-1212': 'grok-4.5',
  'grok-beta': 'grok-4.5',
  'grok-vision-beta': 'grok-4.5',
  // Not grok-4.5: Grok 3 Mini Fast is the budget reasoning tier ($0.60/$4), and Grok 4.5 would
  // be a cost increase. Grok 3 Mini is both current and cheaper ($0.30/$0.50) while keeping
  // can_think, so it preserves intent without raising the bill.
  'grok-3-mini-fast': 'grok-3-mini',
  // Deliberately NOT mapped: `grok-3-mini` ($0.30/$0.50, can_think) is current and has no
  // cheaper replacement. Mapping it to grok-4.5 would raise input cost 6.7x and output 12x
  // for a user who explicitly chose the budget tier.
};

export function resolveDeprecatedModelId(modelId: string, context?: string): string {
  const resolved = DEPRECATED_MODEL_MAP[modelId];
  if (resolved) {
    Logger.globalInstance.warn(
      `[model-sunset] Resolved deprecated model: ${modelId} -> ${resolved} (context: ${context ?? 'unknown'})`
    );
    return resolved;
  }
  return modelId;
}
