import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ThoughtBubbles from './ThoughtBubbles';
import { extractThinking } from '@bike4mind/server-utils/shared/replyUtils';
import { getThemeConfig } from '@client/app/utils/themes';

const { renders } = vi.hoisted(() => ({ renders: { count: 0 } }));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: undefined, setCurrentSession: vi.fn(), currentSessionId: undefined }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: vi.fn() }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => {
    renders.count++;
    return false;
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactElement) => <CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>;

describe('ThoughtBubbles while the reply after the reasoning streams', () => {
  it('does not re-render a 200 KB reasoning block on reply tokens', () => {
    const reasoning = 'step of careful thought\n'.repeat(9000);
    const quest = (answer: string) => ({ replies: [`<think>${reasoning}</think>${answer}`] });
    const bubbles = (answer: string) =>
      wrap(<ThoughtBubbles content={extractThinking(quest(answer) as never)} isStreaming />);
    const { rerender } = render(bubbles('A'));
    expect(screen.getByText(/step of careful thought/)).toBeInTheDocument();
    const settled = renders.count;
    expect(settled).toBeGreaterThan(0);
    let answer = 'A';
    for (let i = 0; i < 50; i++) {
      answer += ' token';
      rerender(bubbles(answer));
    }
    expect(renders.count).toBe(settled);
  });
});
