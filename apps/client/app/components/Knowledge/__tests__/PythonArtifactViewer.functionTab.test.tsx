import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PythonArtifact } from '@bike4mind/common';

const flags = vi.hoisted(() => ({ callableFunctionsEnabled: false }));

vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => flags.callableFunctionsEnabled,
}));
vi.mock('../PythonFunctionPanel', () => ({
  default: ({ code }: { code: string }) => <div data-testid="python-function-panel">{code.length}</div>,
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useServerSettings: () => ({ serverSettings: [] }),
}));
vi.mock('@client/app/hooks/usePyodide', () => ({
  usePyodide: () => ({
    isLoading: false,
    loadProgress: 0,
    error: null,
    isExecuting: false,
    initialize: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    callFunction: vi.fn(),
    interrupt: vi.fn(),
    detectPackages: vi.fn().mockReturnValue([]),
    isReady: vi.fn().mockReturnValue(true),
  }),
}));
vi.mock('@client/app/utils/artifactPersistence', () => ({
  checkArtifactExists: vi.fn().mockResolvedValue(true),
  saveArtifactToLocalStorage: vi.fn(),
  saveArtifactVersionToLocalStorage: vi.fn(),
  getArtifactVersionFromLocalStorage: vi.fn().mockReturnValue(null),
  clearOldCachedArtifacts: vi.fn(),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSelectedArtifactVersion: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('@client/app/components/artifacts', () => ({ ArtifactVersionDropdown: () => null }));
vi.mock('react-simple-code-editor', () => ({
  default: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={event => onValueChange(event.target.value)} />
  ),
}));

import PythonArtifactViewer from '../PythonArtifactViewer';

const appTheme = extendTheme({ ...getThemeConfig() });

const FUNCTION_CODE = 'FUNCTION = {"name": "double"}\n\ndef run(x):\n    return {"y": 2 * x}\n';
const SCRIPT_CODE = 'print(1)\n';

const artifactWith = (content: string) =>
  ({
    id: 'python-1',
    type: 'python',
    title: 'Analysis',
    content,
    metadata: {},
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as PythonArtifact;

const renderViewer = (content: string) => {
  const view = render(
    <CssVarsProvider theme={appTheme}>
      <PythonArtifactViewer artifact={artifactWith(content)} onSave={vi.fn()} />
    </CssVarsProvider>
  );
  return {
    rerender: () =>
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <PythonArtifactViewer artifact={artifactWith(content)} onSave={vi.fn()} />
        </CssVarsProvider>
      ),
  };
};

const tabLabels = () => screen.getAllByRole('tab').map(tab => tab.textContent);
const selectedTab = () => screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true');

describe('PythonArtifactViewer Function tab', () => {
  beforeEach(() => {
    flags.callableFunctionsEnabled = false;
  });

  it('renders exactly the Output and Code tabs when the setting is off', () => {
    renderViewer(FUNCTION_CODE);
    expect(tabLabels()).toEqual(['Output', 'Code']);
    expect(screen.queryByTestId('python-artifact-function-tab')).toBeNull();
  });

  it('renders no Function tab when the code has no entry point', () => {
    flags.callableFunctionsEnabled = true;
    renderViewer(SCRIPT_CODE);
    expect(tabLabels()).toEqual(['Output', 'Code']);
  });

  it('adds the Function tab with the setting on and an entry point in the code', () => {
    flags.callableFunctionsEnabled = true;
    renderViewer(FUNCTION_CODE);
    expect(tabLabels()).toEqual(['Output', 'Code', 'Function']);

    fireEvent.click(screen.getByTestId('python-artifact-function-tab'));
    expect(screen.getByTestId('python-function-panel')).toBeTruthy();
  });

  it('wraps the header and compacts the version control when the pane is narrow', () => {
    flags.callableFunctionsEnabled = true;
    renderViewer(FUNCTION_CODE);
    const header = screen.getByTestId('python-artifact-viewer-header');
    const headerStyle = getComputedStyle(header);
    expect(headerStyle.flexWrap).toBe('wrap');
    expect(headerStyle.getPropertyValue('container-type')).toBe('inline-size');
    expect(getComputedStyle(screen.getByRole('tablist')).flexWrap).toBe('wrap');

    const css = Array.from(document.querySelectorAll('style'))
      .map(style => style.textContent ?? '')
      .join('\n');
    const compactRule = css.match(/@container \(max-width: ?720px\)\{[^@]*\}\}/)?.[0] ?? '';
    expect(compactRule).toMatch(/\.artifact-version-dropdown-label[^{]*\{display:none;\}/);
    expect(compactRule).toMatch(/\.artifact-version-dropdown-button\{min-width:auto;\}/);
  });

  it('returns to the Output tab when the entry point is edited away', () => {
    flags.callableFunctionsEnabled = true;
    renderViewer(SCRIPT_CODE);
    fireEvent.click(screen.getByText('Enable Edit Mode'));
    fireEvent.click(screen.getByText('I Understand, Enable Editing'));
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: FUNCTION_CODE } });

    fireEvent.click(screen.getByTestId('python-artifact-function-tab'));
    expect(selectedTab()?.textContent).toBe('Function');

    // Revert restores the saved script, which has no entry point.
    fireEvent.click(screen.getByText('Revert'));

    expect(tabLabels()).toEqual(['Output', 'Code']);
    expect(selectedTab()?.textContent).toBe('Output');
    expect(screen.queryByTestId('python-function-panel')).toBeNull();
  });

  it('returns to the Output tab when the setting turns off', () => {
    flags.callableFunctionsEnabled = true;
    const { rerender } = renderViewer(FUNCTION_CODE);
    fireEvent.click(screen.getByTestId('python-artifact-function-tab'));

    flags.callableFunctionsEnabled = false;
    rerender();

    expect(tabLabels()).toEqual(['Output', 'Code']);
    expect(selectedTab()?.textContent).toBe('Output');
  });
});
