import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { CodeBlockActionOutput } from '@client/app/components/common/CodeBlockActions';
import { registerCodeBlockAction, type CodeBlockActionProps } from '@client/app/utils/codeBlockActions';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ArtifactPreviewCard from './ArtifactPreviewCard';

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: null }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { autoCollapseContent: true, maxVisibleLines: 5 } }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => null }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({ useSelectedAccount: () => null }));
vi.mock('@client/app/hooks/usePublishShare', () => ({
  usePublishShare: () => ({ publishAndShare: vi.fn(), modal: null }),
}));
vi.mock('@client/app/hooks/useSelectedArtifactContentSync', () => ({
  useSelectedArtifactContentSync: vi.fn(),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({
  setSessionLayout: vi.fn(),
  setSelectedArtifactVersion: vi.fn(),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));

const appTheme = extendTheme({ ...getThemeConfig() });

const RunControl: React.FC<CodeBlockActionProps> = ({ code, language, outputSlot }) => (
  <>
    <button data-testid="code-block-run-btn" data-language={language}>
      {code}
    </button>
    <CodeBlockActionOutput outputSlot={outputSlot}>
      <button data-testid="code-block-run-output">ran</button>
    </CodeBlockActionOutput>
  </>
);

const SOURCE = 'import numpy as np\nprint(np.arange(3))';

function renderCard(props: { source?: string; sourceLanguage?: string }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <ArtifactPreviewCard
          artifactId="artifact_python_script_1"
          artifactType="python"
          mimeType="application/vnd.ant.python"
          artifactContent={{} as never}
          contentKey={props.source ?? ''}
          title="Python Script"
          chipLabel="Python"
          testIdPrefix="python"
          {...props}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

describe('ArtifactPreviewCard actions', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    act(() => unregister?.());
    vi.mocked(setSessionLayout).mockClear();
  });

  function registerPythonRun() {
    act(() => {
      unregister = registerCodeBlockAction({
        id: 'run',
        appliesTo: language => language === 'python',
        Control: RunControl,
      });
    });
  }

  it('renders a registered action for the source language and portals its output into the card', () => {
    registerPythonRun();
    renderCard({ source: SOURCE, sourceLanguage: 'python' });

    const control = screen.getByTestId('code-block-run-btn');
    expect(control.textContent).toBe(SOURCE);
    expect(control.getAttribute('data-language')).toBe('python');
    expect(screen.getByTestId('code-block-action-output').contains(screen.getByTestId('code-block-run-output'))).toBe(
      true
    );
  });

  it('keeps clicks on the action and its output from opening the side viewer', () => {
    registerPythonRun();
    renderCard({ source: SOURCE, sourceLanguage: 'python' });

    fireEvent.click(screen.getByTestId('code-block-run-btn'));
    fireEvent.click(screen.getByTestId('code-block-run-output'));
    expect(setSessionLayout).not.toHaveBeenCalled();

    // Control: the card itself still opens the viewer.
    fireEvent.click(screen.getByText('Python Script'));
    expect(setSessionLayout).toHaveBeenCalled();
  });

  it('offers no action on a card without a source language', () => {
    registerPythonRun();
    renderCard({ source: SOURCE });

    expect(screen.queryByTestId('code-block-run-btn')).toBeNull();
  });
});
