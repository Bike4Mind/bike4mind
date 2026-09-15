/**
 * Chart label and aggregation bucket for the usage-by-model breakdown. Metadata is checked first for
 * rows predating the top-level `model` field - no current writer sets `metadata.modelName`, so the
 * branch looks dead: keep it. Non-string or empty values count as absent, since a number or object
 * reaching the bucket key would render as "42" or "[object Object]".
 */
export function resolveModelName(transaction: { metadata?: Record<string, unknown>; model?: unknown }): string {
  const fromMetadata = transaction.metadata?.modelName;
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;

  const fromField = transaction.model;
  if (typeof fromField === 'string' && fromField) return fromField;

  return 'Unknown';
}
