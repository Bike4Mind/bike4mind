import { IVariantDocument, VariantContent, AudienceKey } from '@bike4mind/common';

/**
 * Serve-time leak guard.
 *
 * Flattens exactly one audience variant into top-level content fields and strips
 * `variants` and `generationMetadata` before the document reaches any client.
 *
 * Applied to EVERY viewer, including admins, on the serving endpoint. Never
 * bypassed. Admin authoring (which needs the raw `variants` map) uses a
 * dedicated endpoint that does not call this function.
 *
 * Guard is a deny-list: it strips `variants` and `generationMetadata` and
 * passes every other top-level field through. Any new internal-only top-level
 * field MUST be added to the strip set - treat that as a security change.
 * Consumers handling highly sensitive content should invert this to an
 * allow-list instead.
 */
export function extractVariantForViewer<D extends IVariantDocument<K>, K extends AudienceKey = AudienceKey>(
  doc: D,
  audienceKey: K
): Omit<D, 'variants' | 'generationMetadata'> | null {
  const { variants, generationMetadata: _gm, ...rest } = doc;

  if (!variants || Object.keys(variants).length === 0) {
    // Legacy document with no variants map - pass through minus generationMetadata.
    // Safe only for public-by-construction documents. Do not route internal-only
    // legacy documents through this function.
    return rest as Omit<D, 'variants' | 'generationMetadata'>;
  }

  const content: VariantContent | undefined = variants[audienceKey];
  if (!content) {
    // No content for this audience key - drop the document from the served set.
    return null;
  }

  // Merge only defined fields so an absent variant field (undefined) never
  // clobbers a top-level value. Explicit nulls pass through intentionally.
  const defined = Object.fromEntries(Object.entries(content).filter(([, v]) => v !== undefined));

  return { ...rest, ...defined } as Omit<D, 'variants' | 'generationMetadata'>;
}
