import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const serverSettings = vi.hoisted(() => ({ current: [] as { settingName: string; settingValue: unknown }[] }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: serverSettings.current }),
}));

import { describePythonNetworkAccess, usePythonArtifactDataOrigins } from './usePythonArtifactDataOrigins';

const withStored = (settingValue: unknown) => {
  serverSettings.current = [{ settingName: 'pythonArtifactDataOrigins', settingValue }];
};

describe('usePythonArtifactDataOrigins', () => {
  beforeEach(() => {
    serverSettings.current = [];
  });

  it('is empty when the setting is absent', () => {
    expect(renderHook(() => usePythonArtifactDataOrigins()).result.current).toEqual([]);
  });

  it('returns the canonical origins of a valid list', () => {
    withStored(['https://Data.example.org/', 'https://stats.example.net']);
    expect(renderHook(() => usePythonArtifactDataOrigins()).result.current).toEqual([
      'https://data.example.org',
      'https://stats.example.net',
    ]);
  });

  it('is empty when any stored entry is invalid, as the sandbox CSP would be', () => {
    withStored(['https://data.example.org', 'https://10.0.0.1']);
    expect(renderHook(() => usePythonArtifactDataOrigins()).result.current).toEqual([]);
  });
});

describe('describePythonNetworkAccess', () => {
  it('names only the package CDN when nothing is listed', () => {
    expect(describePythonNetworkAccess([])).toBe('Network access is limited to the Python package CDN');
  });

  it('names every listed origin', () => {
    expect(describePythonNetworkAccess(['https://data.example.org', 'https://stats.example.net'])).toBe(
      'Network access is limited to the Python package CDN and reading data from https://data.example.org, https://stats.example.net'
    );
  });
});
