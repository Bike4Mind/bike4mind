import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ThoughtBubbles from './ThoughtBubbles';
import { getThemeConfig } from '@client/app/utils/themes';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactElement) => <CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>;

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: undefined, setCurrentSession: vi.fn(), currentSessionId: undefined }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('ThoughtBubbles without the reveal animation', () => {
  it('replaces the text when a new quest reuses the bubble with unrelated reasoning', () => {
    const { rerender } = render(wrap(<ThoughtBubbles content="<think>old reasoning about cats" isStreaming />));
    rerender(wrap(<ThoughtBubbles content="<think>fresh plan" isStreaming />));

    expect(screen.getByText('fresh plan')).toBeInTheDocument();
    expect(screen.queryByText(/cats/)).not.toBeInTheDocument();
  });

  it('keeps the full text and switches the label when streaming ends', () => {
    const long = `<think>${'step '.repeat(4000)}end</think>`;
    const { rerender } = render(wrap(<ThoughtBubbles content={long} isStreaming />));
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
    rerender(wrap(<ThoughtBubbles content={long} isStreaming={false} />));

    expect(screen.getByText('Thoughts')).toBeInTheDocument();
    expect(screen.getByText(/step end$/)).toBeInTheDocument();
  });

  it('shows reasoning that arrives after the reply finished streaming', () => {
    const { rerender } = render(wrap(<ThoughtBubbles content="" isStreaming={false} />));
    expect(screen.queryByText('Thoughts')).not.toBeInTheDocument();
    rerender(wrap(<ThoughtBubbles content="<think>late thought</think>" isStreaming={false} />));

    expect(screen.getByText('late thought')).toBeInTheDocument();
  });
});
