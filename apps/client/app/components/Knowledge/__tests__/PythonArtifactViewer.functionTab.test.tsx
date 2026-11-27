import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PythonArtifact } from '@bike4mind/common';

const flags = vi.hoisted(() => ({
  callableFunctionsEnabled: false,
  persisted: true,
  stored: undefined as unknown,
  artifactQuery: vi.fn(),
}));

vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => flags.callableFunctionsEnabled,
}));
vi.mock('@client/app/hooks/data/artifacts', () => ({
  useArtifact: (artifactId: string | null) => {
    flags.artifactQuery(artifactId);
    return { data: artifactId ? flags.stored : undefined };
  },
}));
vi.mock('../PythonFunctionPanel', () => ({
  default: ({ code, save }: { code: string; save: unknown }) => (
    <div data-testid="python-function-panel" data-save={JSON.stringify(save)}>
      {code.length}
    </div>
  ),
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
  checkArtifactExists: () => Promise.resolve(flags.persisted),
  saveArtifactToLocalStorage: vi.fn(),
  saveArtifactVersionToLocalStorage: vi.fn(),
  getArtifactVersionFromLocalStorage: vi.fn().mockReturnValue(null),
  clearOldCachedArtifacts: vi.fn(),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSelectedArtifactVersion: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('@client/app/components/artifacts', () => ({
  ArtifactVersionDropdown: ({ onVersionChange }: { onVersionChange: (version: number) => void }) => (
    <>
      <button onClick={() => onVersionChange(1)}>Show version 1</button>
      <button onClick={() => onVersionChange(2)}>Show version 2</button>
    </>
  ),
}));
vi.mock('react-simple-code-editor', () => ({
  default: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => (
    <textarea data-testid="code-editor" value={value} onChange={event => onValueChange(event.target.value)} />
  ),
}));

import PythonArtifactViewer from '../PythonArtifactViewer';

const appTheme = extendTheme({ ...getThemeConfig() });

const FUNCTION_CODE = 'FUNCTION = {"name": "double"}\n\ndef run(x):\n    return {"y": 2 * x}\n';
const SCRIPT_CODE = 'print(1)\n';

const artifactWith = (content: string, version = 1) =>
  ({
    id: 'python-1',
    type: 'python',
    title: 'Analysis',
    content,
    metadata: {},
    version,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as PythonArtifact;

const renderViewer = (content: string, { version = 1, readOnly = false, saveResult = undefined as unknown } = {}) => {
  const onSave = readOnly ? undefined : vi.fn().mockResolvedValue(saveResult);
  const view = render(
    <CssVarsProvider theme={appTheme}>
      <PythonArtifactViewer artifact={artifactWith(content, version)} onSave={onSave} />
    </CssVarsProvider>
  );
  return {
    rerender: () =>
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <PythonArtifactViewer artifact={artifactWith(content, version)} onSave={onSave} />
        </CssVarsProvider>
      ),
  };
};

const tabLabels = () => screen.getAllByRole('tab').map(tab => tab.textContent);
const selectedTab = () => screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true');

describe('PythonArtifactViewer Function tab', () => {
  beforeEach(() => {
    flags.callableFunctionsEnabled = false;
    flags.persisted = true;
    flags.stored = undefined;
    flags.artifactQuery.mockReset();
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

describe('PythonArtifactViewer save target for the Function tab', () => {
  // The stored id differs from the chat artifact's, as for an artifact saved under a legacy identifier.
  const owned = (version = 1) => ({ access: 'owner', artifact: { id: 'python-1_1700000000000_0', version } });

  const openFunctionTab = () => fireEvent.click(screen.getByTestId('python-artifact-function-tab'));
  const save = () => JSON.parse(screen.getByTestId('python-function-panel').getAttribute('data-save') ?? 'null');
  const waitForSave = (expected: unknown) => waitFor(() => expect(save()).toEqual(expected));

  const editCode = (value: string) => {
    fireEvent.click(screen.getByText('Enable Edit Mode'));
    fireEvent.click(screen.getByText('I Understand, Enable Editing'));
    fireEvent.click(screen.getByRole('tab', { name: 'Code' }));
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value } });
  };

  beforeEach(() => {
    flags.callableFunctionsEnabled = true;
    flags.persisted = true;
    flags.stored = owned();
    flags.artifactQuery.mockReset();
  });

  it("targets the owner's stored artifact at the version shown", async () => {
    renderViewer(FUNCTION_CODE);
    openFunctionTab();

    await waitForSave({ artifactId: 'python-1_1700000000000_0', version: 1, blocked: null });
    expect(flags.artifactQuery).toHaveBeenLastCalledWith('python-1');
  });

  it('offers no save to a person who does not own the artifact', async () => {
    flags.stored = { access: 'shared', artifact: { id: 'python-1', version: 1 } };
    renderViewer(FUNCTION_CODE);
    openFunctionTab();

    await waitFor(() => expect(flags.artifactQuery).toHaveBeenLastCalledWith('python-1'));
    expect(save()).toBeNull();
  });

  it('offers no save in a read-only viewer and does not ask the server', async () => {
    renderViewer(FUNCTION_CODE, { readOnly: true });
    openFunctionTab();

    await waitFor(() => expect(flags.artifactQuery).toHaveBeenCalled());
    expect(save()).toBeNull();
    expect(flags.artifactQuery).not.toHaveBeenCalledWith('python-1');
  });

  it('does not ask the server whose artifact it is while the setting is off', async () => {
    flags.callableFunctionsEnabled = false;
    renderViewer(FUNCTION_CODE);

    await waitFor(() => expect(flags.artifactQuery).toHaveBeenCalled());
    expect(flags.artifactQuery).not.toHaveBeenCalledWith('python-1');
  });

  it('asks for the artifact to be saved first when it is not in the database', async () => {
    flags.persisted = false;
    renderViewer(FUNCTION_CODE);
    openFunctionTab();

    // The chat artifact's own id, so a tool whose artifact was deleted can still show its status.
    await waitForSave({ artifactId: 'python-1', version: 1, blocked: 'Save the artifact to make it a tool.' });
    expect(flags.artifactQuery).not.toHaveBeenCalledWith('python-1');
  });

  it('asks for unsaved changes to be saved first', async () => {
    renderViewer(FUNCTION_CODE);
    editCode(`${FUNCTION_CODE}\n`);
    openFunctionTab();

    await waitForSave({
      artifactId: 'python-1_1700000000000_0',
      version: 1,
      blocked: 'Save your changes to make this a tool.',
    });
  });

  it('asks to switch to the latest version while an older one is shown, and targets it again once it is', async () => {
    flags.stored = owned(2);
    renderViewer(FUNCTION_CODE, { version: 2 });
    openFunctionTab();
    await waitForSave({ artifactId: 'python-1_1700000000000_0', version: 2, blocked: null });

    fireEvent.click(screen.getByText('Show version 1'));
    await waitForSave({
      artifactId: 'python-1_1700000000000_0',
      version: 1,
      blocked: 'Switch to the latest version to make this a tool.',
    });

    fireEvent.click(screen.getByText('Show version 2'));
    await waitForSave({ artifactId: 'python-1_1700000000000_0', version: 2, blocked: null });
  });

  it('asks to switch to the latest version when the chat artifact reopens behind the stored head', async () => {
    flags.stored = owned(2);
    renderViewer(FUNCTION_CODE, { version: 1 });
    openFunctionTab();

    await waitForSave({
      artifactId: 'python-1_1700000000000_0',
      version: 1,
      blocked: 'Switch to the latest version to make this a tool.',
    });
  });

  it('asks to switch back to a version saved here while the cached stored head is older', async () => {
    flags.stored = owned(1);
    renderViewer(FUNCTION_CODE, { saveResult: { artifact: { version: 2 } } });
    editCode(`${FUNCTION_CODE}\n`);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    openFunctionTab();
    await waitForSave({ artifactId: 'python-1_1700000000000_0', version: 2, blocked: null });

    fireEvent.click(screen.getByText('Show version 1'));
    await waitForSave({
      artifactId: 'python-1_1700000000000_0',
      version: 1,
      blocked: 'Switch to the latest version to make this a tool.',
    });
  });

  it('targets a version just saved while the stored head is still being read again', async () => {
    flags.stored = owned(1);
    renderViewer(FUNCTION_CODE, { version: 2 });
    openFunctionTab();

    await waitForSave({ artifactId: 'python-1_1700000000000_0', version: 2, blocked: null });
  });
});
