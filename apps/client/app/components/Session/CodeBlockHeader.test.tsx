import React from 'react';
import { createPortal } from 'react-dom';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { registerCodeBlockAction, type CodeBlockActionProps } from '@client/app/utils/codeBlockActions';
import { CodeBlockHeader } from './CodeBlockHeader';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const RunControl: React.FC<CodeBlockActionProps> = ({ code, language, outputSlot }) => (
  <>
    <button data-testid="code-block-run-btn">
      run {language}: {code}
    </button>
    {outputSlot && createPortal(<span data-testid="code-block-run-output">ran</span>, outputSlot)}
  </>
);

const renderBlock = (language: string) =>
  render(
    <TestWrapper>
      <CodeBlockHeader code="print(1)" language={language}>
        <pre>print(1)</pre>
      </CodeBlockHeader>
    </TestWrapper>
  );

describe('CodeBlockHeader actions', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    act(() => cleanups.splice(0).forEach(cleanup => cleanup()));
  });

  const register = (appliesTo: (language: string) => boolean, id = 'run') => {
    act(() => {
      cleanups.push(registerCodeBlockAction({ id, appliesTo, Control: RunControl }));
    });
  };

  it('renders only the copy control when nothing is registered', () => {
    renderBlock('python');
    expect(screen.queryByTestId('code-block-run-btn')).toBeNull();
  });

  it('renders a matching action with the code and portals its output under the code', () => {
    register(language => language === 'python');
    renderBlock('python');

    expect(screen.getByTestId('code-block-run-btn').textContent).toBe('run python: print(1)');
    const outlet = screen.getByTestId('code-block-action-output');
    expect(outlet.contains(screen.getByTestId('code-block-run-output'))).toBe(true);
  });

  it('skips an action that does not apply to the language', () => {
    register(language => language === 'python');
    renderBlock('javascript');
    expect(screen.queryByTestId('code-block-run-btn')).toBeNull();
  });

  it('follows registration and unregistration while mounted', () => {
    renderBlock('python');
    register(() => true);
    expect(screen.getByTestId('code-block-run-btn')).toBeTruthy();

    act(() => cleanups.splice(0).forEach(cleanup => cleanup()));
    expect(screen.queryByTestId('code-block-run-btn')).toBeNull();
  });

  it('a re-registration under the same id replaces the action, and the stale cleanup leaves it in place', () => {
    register(() => true);
    const staleCleanup = cleanups.pop()!;
    register(() => true);
    renderBlock('python');
    expect(screen.getAllByTestId('code-block-run-btn')).toHaveLength(1);

    act(() => staleCleanup());
    expect(screen.getAllByTestId('code-block-run-btn')).toHaveLength(1);
  });

  it('passes "text" to actions when the fence has no language', () => {
    register(language => language === 'text');
    render(
      <TestWrapper>
        <CodeBlockHeader code="x">
          <pre>x</pre>
        </CodeBlockHeader>
      </TestWrapper>
    );
    expect(screen.getByTestId('code-block-run-btn').textContent).toBe('run text: x');
  });
});
