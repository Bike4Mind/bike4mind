import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ThoughtBubbles from './ThoughtBubbles';
import { extractThinking } from '@client/app/utils/replyUtils';
import { getThemeConfig } from '@client/app/utils/themes';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

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

// Regression coverage for the wiring bug: PromptReplies used to pass a whole reply slot
// (answer text and raw <think> markers included) to ThoughtBubbles instead of parsed
// thinking content. These render `content` the way PromptReplies now does - through
// extractThinking - so a future regression there breaks a component test, not just the
// pure-function ones in replyUtils.test.ts.
describe('ThoughtBubbles', () => {
  it('shows the reopened block from a mixed slot, not the answer text or raw markers', () => {
    const thought = extractThinking({ replies: ['partial <think>second reasoning</think>final answer'] });
    renderWithTheme(<ThoughtBubbles content={thought} isStreaming={false} />);

    expect(screen.getByText('second reasoning')).toBeInTheDocument();
    expect(screen.queryByText(/final answer/)).not.toBeInTheDocument();
    expect(screen.queryByText(/<think>/)).not.toBeInTheDocument();
  });

  it('shows both blocks from the accumulator two-slot sequence, not just the first slot', () => {
    const thought = extractThinking({
      replies: ['<think>first reasoning</think>', 'PARTIAL ANSWER <think>second reasoning</think>FINAL ANSWER'],
    });
    renderWithTheme(<ThoughtBubbles content={thought} isStreaming={false} />);

    expect(screen.getByText(/first reasoning/)).toBeInTheDocument();
    expect(screen.getByText(/second reasoning/)).toBeInTheDocument();
  });
});
