import { useEffect } from 'react';
import { submittedTagPrefix } from '@bike4mind/common';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { activeOrgId, useDataLakeSlugPreview } from '@client/app/hooks/data/dataLakes';
import { canReuseRecoverableLake } from '@client/app/hooks/data/dataLakeUploadPipeline';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

/**
 * The wizard's server-checked identity for a new lake: the slug and first free tag prefix
 * (useDataLakeSlugPreview), shared by ConfigStep (display + adopting an auto-picked prefix) and
 * DataLakeWizardModal (the Start Upload gate) so the two cannot drift. Same args give the same
 * query key, so both share one fetch.
 *
 * - While the prefix is still auto-derived, no prefix is sent: the server derives the same base
 *   from the name, so adopting its answer (`acme-1:`) does not re-key the query into `acme-1-1:`.
 * - A hand-typed prefix is sent debounced, and `heldTypedPrefix` is true only when the answer
 *   for the CURRENT value says it is held - never while loading, on error, or mid-debounce.
 * - A retry that will restore the lake a failed attempt archived (canReuseRecoverableLake) skips
 *   the preview: that lake holds the prefix itself, and reusing it is the point.
 */
export function useWizardIdentityPreview(enabled: boolean) {
  const config = useDataLakeWizardStore(s => s.config);
  const autoDerivedTagPrefix = useDataLakeWizardStore(s => s.autoDerivedTagPrefix);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);
  const recoverableLake = useDataLakeWizardStore(s => s.recoverableLake);

  const submitted = submittedTagPrefix(config.tagPrefix);
  const reusedLake = canReuseRecoverableLake(recoverableLake, submitted, activeOrgId()) ? recoverableLake : null;
  const isAutoPrefix = !!autoDerivedTagPrefix && config.tagPrefix === autoDerivedTagPrefix;

  const { debouncedValue, setValue } = useDebounceValue(submitted, 400);
  useEffect(() => setValue(submitted), [submitted]);
  const sentPrefix = isAutoPrefix ? undefined : debouncedValue || undefined;

  const active = enabled && !targetLake && !reusedLake && !!config.name;
  const slugPreview = useDataLakeSlugPreview(config.name, sentPrefix, active);
  // A disabled query still serves cached data, which must not flag or adopt anything here.
  const suggestedTagPrefix = active ? (slugPreview.data?.tagPrefix ?? null) : null;
  const heldTypedPrefix =
    !isAutoPrefix &&
    !!sentPrefix &&
    sentPrefix === submitted &&
    !!suggestedTagPrefix &&
    suggestedTagPrefix !== sentPrefix;

  return { reusedLake, slugPreview, isAutoPrefix, suggestedTagPrefix, heldTypedPrefix };
}
