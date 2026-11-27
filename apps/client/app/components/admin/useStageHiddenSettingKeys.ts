import { useMemo } from 'react';
import { stageHiddenSettingKeys } from '@bike4mind/common';
import { useConfig } from '@client/app/hooks/data/settings';

/** Setting keys this stage hides from admins. Until the server reports its list, every stage-gated key is hidden rather than flashed. */
export function useStageHiddenSettingKeys(): ReadonlySet<string> {
  const { data } = useConfig();
  return useMemo(() => {
    const keys = data?.hiddenAdminSettingKeys;
    return new Set<string>(Array.isArray(keys) ? keys : stageHiddenSettingKeys(true));
  }, [data]);
}
