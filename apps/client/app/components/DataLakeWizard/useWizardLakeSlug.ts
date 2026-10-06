import { useEffect } from 'react';
import { slugifyDataLakeName, submittedTagPrefix } from '@bike4mind/common';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { activeOrgId, useDataLakeSlugPreview } from '@client/app/hooks/data/dataLakes';
import { canReuseRecoverableLake } from '@client/app/hooks/data/dataLakeUploadPipeline';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

/**
 * The slug the wizard displays, shared by the source step (where the name is typed) and the
 * Config summary so the two never disagree. Append mode reuses the target lake's real slug
 * (which may be disambiguated, e.g. "niche-2"). Create mode asks the server, because a lake
 * (even a deleted one) already holding the slug pushes the new one to "-1"; slugify is only the
 * fallback while that loads or if it fails. A retry that will restore the lake a failed attempt
 * archived (same rule as resolveCreateModeLake) keeps that lake's slug.
 */
export function useWizardLakeSlug(): string {
  const config = useDataLakeWizardStore(s => s.config);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);
  const recoverableLake = useDataLakeWizardStore(s => s.recoverableLake);
  const reusedLake = canReuseRecoverableLake(recoverableLake, submittedTagPrefix(config.tagPrefix), activeOrgId())
    ? recoverableLake
    : null;

  // Debounced so typing on the source step doesn't query per keystroke. Until it catches up the
  // preview belongs to an older name, so it is ignored in favor of the local slugify.
  const { debouncedValue: debouncedName, setValue: setDebounceName } = useDebounceValue(config.name);
  useEffect(() => setDebounceName(config.name), [config.name, setDebounceName]);
  const slugPreview = useDataLakeSlugPreview(debouncedName, !targetLake && !reusedLake && !!debouncedName);
  const settledPreview = debouncedName === config.name ? slugPreview.data : undefined;

  if (targetLake) return targetLake.slug;
  return reusedLake?.slug ?? settledPreview ?? slugifyDataLakeName(config.name);
}
