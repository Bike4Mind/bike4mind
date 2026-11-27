import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PythonArtifact } from '@bike4mind/common';

const serverSettings = vi.hoisted(() => ({ current: [] as { settingName: string; settingValue: unknown }[] }));

vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: serverSettings.current }),
}));
vi.mock('@client/app/hooks/usePyodide', () => ({
  usePyodide: () => ({
    isLoading: false,
    loadProgress: 0,
    error: null,
    isExecuting: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    interrupt: vi.fn(),
    detectPackages: vi.fn().mockReturnValue([]),
    isReady: vi.fn().mockReturnValue(false),
  }),
}));
vi.mock('@client/app/utils/artifactPersistence', () => ({
  checkArtifactExists: vi.fn().mockResolvedValue(false),
  saveArtifactToLocalStorage: vi.fn(),
  saveArtifactVersionToLocalStorage: vi.fn(),
  getArtifactVersionFromLocalStorage: vi.fn().mockReturnValue(null),
  clearOldCachedArtifacts: vi.fn(),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSelectedArtifactVersion: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('@client/app/components/artifacts', () => ({ ArtifactVersionDropdown: () => null }));
vi.mock('@client/app/hooks/data/callableFunctions', () => ({ useCallableFunctionsEnabled: () => false }));
vi.mock('@client/app/hooks/data/artifacts', () => ({ useArtifact: () => ({ data: undefined }) }));

import PythonArtifactViewer from '../PythonArtifactViewer';

const appTheme = extendTheme({ ...getThemeConfig() });

const artifact = {
  id: 'python-1',
  type: 'python',
  title: 'Analysis',
  content: 'print(1)',
  metadata: {},
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as PythonArtifact;

const openNote = () => {
  render(
    <CssVarsProvider theme={appTheme}>
      <PythonArtifactViewer artifact={artifact} onSave={vi.fn()} />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByText('Enable Edit Mode'));
  return screen.getByTestId('python-artifact-network-note');
};

describe('PythonArtifactViewer network note', () => {
  beforeEach(() => {
    serverSettings.current = [];
  });

  it('names the package CDN and each listed data origin', () => {
    serverSettings.current = [{ settingName: 'pythonArtifactDataOrigins', settingValue: ['https://data.example.org'] }];
    expect(openNote().textContent).toBe(
      'Network access is limited to the Python package CDN and reading data from https://data.example.org'
    );
  });

  it('names only the package CDN when nothing is listed', () => {
    const note = openNote();
    expect(note.textContent).toBe('Network access is limited to the Python package CDN');
    expect(note.textContent).not.toMatch(/CORS-allowed|Cannot access the network/);
  });
});
