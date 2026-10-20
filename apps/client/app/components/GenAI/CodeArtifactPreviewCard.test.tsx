import React from 'react';
import { createPortal } from 'react-dom';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { registerCodeBlockAction, type CodeBlockActionProps } from '@client/app/utils/codeBlockActions';
import CodeArtifactPreviewCard from './CodeArtifactPreviewCard';

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: null }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { autoCollapseContent: true, maxVisibleLines: 5 } }),
}));
vi.mock('@client/app/hooks/useSelectedArtifactContentSync', () => ({
  useSelectedArtifactContentSync: vi.fn(),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));

const appTheme = extendTheme({ ...getThemeConfig() });

const RunControl: React.FC<CodeBlockActionProps> = ({ code, language, outputSlot }) => (
  <>
    <button data-testid="code-block-run-btn" data-language={language}>
      {code}
    </button>
    {outputSlot && createPortal(<span data-testid="code-block-run-output">ran</span>, outputSlot)}
  </>
);

describe('CodeArtifactPreviewCard actions', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    act(() => unregister?.());
  });

  it('renders a registered action with the full (untruncated) code and portals its output into the card', () => {
    act(() => {
      unregister = registerCodeBlockAction({
        id: 'run',
        appliesTo: language => language === 'python',
        Control: RunControl,
      });
    });
    const code = Array.from({ length: 12 }, (_, line) => `print(${line})`).join('\n');

    render(
      <CssVarsProvider theme={appTheme}>
        <CodeArtifactPreviewCard
          data={{ title: 'script', description: '', language: 'python', code, lineCount: 12 }}
          artifactId="code-python-1"
        />
      </CssVarsProvider>
    );

    const control = screen.getByTestId('code-block-run-btn');
    expect(control.textContent).toBe(code);
    expect(control.getAttribute('data-language')).toBe('python');
    expect(screen.getByTestId('code-block-action-output').contains(screen.getByTestId('code-block-run-output'))).toBe(
      true
    );
  });
});
