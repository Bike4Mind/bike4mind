import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../utils/themes';
import PromptReplies from './PromptReplies';

vi.mock('./ImageContainer', () => ({
  default: ({ src }: { src: string }) => <img data-testid="reply-image-loaded" src={src} alt="" />,
}));

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: { post: postMock } };
});

// ReplyContainer is the only consumer of these, reached from the default export below; the
// banner's wiring can only be exercised by rendering the whole reply, which needs them stubbed.
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 'session-1', currentSession: null, setCurrentSession: vi.fn() }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {} }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/useMessageEditMode', () => {
  const state = { editingMessageId: undefined, editTarget: undefined, clearEdit: vi.fn() };
  return { useMessageEditMode: (selector: (s: typeof state) => unknown) => selector(state) };
});

const appTheme = extendTheme({ ...getThemeConfig() });
const queryClient = new QueryClient();
const sendMessage = async () => {};

const Reply = ({ text, status }: { text: string; status: string }) => (
  <QueryClientProvider client={queryClient}>
    <CssVarsProvider theme={appTheme}>
      <PromptReplies
        messageData={{ id: 'quest-r4', sessionId: 'session-1', questMasterReply: text, status } as never}
        onSendMessage={sendMessage}
      />
    </CssVarsProvider>
  </QueryClientProvider>
);

const codeText = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('pre code'))
    .map(el => el.textContent)
    .join('|');

describe('PromptReplies, round 4', () => {
  it('shows the same code for a fence indented under a numbered step whether the reply streamed here or loaded from history', () => {
    const text = '1. Install the dependencies:\n\n  ```bash\n  npm install\n  npm run build\n  ```\n\n2. Start the server.';
    const history = render(<Reply text={text} status="done" />);
    const fromHistory = codeText(history.container);
    cleanup();
    const live = render(<Reply text={text.slice(0, 1)} status="running" />);
    for (let i = 2; i <= text.length; i++) live.rerender(<Reply text={text.slice(0, i)} status="running" />);
    live.rerender(<Reply text={text} status="done" />);
    expect(fromHistory).toContain('npm install');
    expect(codeText(live.container)).toBe(fromHistory);
  });
});
