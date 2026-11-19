import { useMemo } from 'react';
import { pythonDataOriginReservedHosts, resolvePythonArtifactDataOrigins, settingsMap } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';

/**
 * The data origins Python artifact code may fetch from, validated the same way
 * `/api/pyodide-sandbox` validates them for its CSP. Display only: the sandbox enforces the list.
 * The browser has no deployment environment, so the page's own site stands in for the app's hosts.
 */
export function usePythonArtifactDataOrigins(): string[] {
  const { serverSettings } = useServerSettings();
  const stored = serverSettings?.find(setting => setting.settingName === 'pythonArtifactDataOrigins')?.settingValue;
  const artifactsSetting =
    serverSettings?.find(setting => setting.settingName === 'EnableArtifacts')?.settingValue ??
    settingsMap.EnableArtifacts.defaultValue;
  const artifactsEnabled = String(artifactsSetting) === 'true' || String(artifactsSetting) === '1';
  return useMemo(
    () =>
      artifactsEnabled
        ? resolvePythonArtifactDataOrigins(
            stored,
            pythonDataOriginReservedHosts([window.location.origin], host =>
              registrableDomain(host, { allowPrivateDomains: true })
            )
          )
        : [],
    [stored, artifactsEnabled]
  );
}

export function describePythonNetworkAccess(origins: readonly string[]): string {
  return origins.length === 0
    ? 'Network access is limited to the Python package CDN'
    : `Network access is limited to the Python package CDN and reading data from ${origins.join(', ')}`;
}
