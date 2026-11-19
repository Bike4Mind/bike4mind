import { useMemo } from 'react';
import { pythonDataOriginReservedHosts, resolvePythonArtifactDataOrigins } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';

/**
 * The data origins Python artifact code may fetch from, validated the same way
 * `/api/pyodide-sandbox` validates them for its CSP. Display only: the sandbox enforces the list.
 */
export function usePythonArtifactDataOrigins(): string[] {
  const { serverSettings } = useServerSettings();
  const stored = serverSettings?.find(setting => setting.settingName === 'pythonArtifactDataOrigins')?.settingValue;
  return useMemo(
    () =>
      resolvePythonArtifactDataOrigins(
        stored,
        pythonDataOriginReservedHosts([window.location.origin], host => registrableDomain(host))
      ),
    [stored]
  );
}

export function describePythonNetworkAccess(origins: readonly string[]): string {
  return origins.length === 0
    ? 'Cannot access the network'
    : `Network access is limited to reading data from ${origins.join(', ')}`;
}
