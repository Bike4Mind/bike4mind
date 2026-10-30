import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
        messageData={{ id: 'quest-r2', sessionId: 'session-1', questMasterReply: text, status } as never}
        onSendMessage={sendMessage}
      />
    </CssVarsProvider>
  </QueryClientProvider>
);

const REPLY = 'Here is the chart you asked for.\n\n![chart](https://example.com/c.png)\n\nIt shows growth.';

describe('PromptReplies keeps per-block component state when the reply completes', () => {
  it.each(['done', 'stopped'])('an image approved while running stays loaded after running -> %s', status => {
    const { rerender } = render(<Reply text={REPLY} status="running" />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
    rerender(<Reply text={REPLY} status={status} />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('control: an image in the first block survives running -> done', () => {
    const text = '![chart](https://example.com/c.png)\n\nIt shows growth.';
    const { rerender } = render(<Reply text={text} status="running" />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Reply text={text} status="done" />);
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });
});
