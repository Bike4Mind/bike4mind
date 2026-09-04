import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import RapidReplyBubble from './RapidReplyBubble';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

type BubbleProps = React.ComponentProps<typeof RapidReplyBubble>;

const QUEST = 'quest-1';

const completion = (over: Record<string, unknown> = {}) =>
  ({
    statusMessage: 'Running...',
    rapidReply: { questId: QUEST, content: 'Give me a moment.', status: 'streaming' },
    ...over,
  }) as unknown as BubbleProps['chatCompletion'];

const renderBubble = (chatCompletion: BubbleProps['chatCompletion'], questId: string | undefined) =>
  render(
    <TestWrapper>
      <RapidReplyBubble chatCompletion={chatCompletion} questId={questId} />
    </TestWrapper>
  );

describe('RapidReplyBubble', () => {
  it('renders the acknowledgement while the real answer is still running', () => {
    renderBubble(completion(), QUEST);
    expect(screen.getByTestId('rapid-reply-container')).toHaveTextContent('Give me a moment.');
  });

  // 'replaced' means the real answer superseded it; keeping it would leave the user
  // reading a stale placeholder above the answer that replaced it.
  it('disappears once the real reply has replaced it', () => {
    renderBubble(
      completion({ rapidReply: { questId: QUEST, content: 'Give me a moment.', status: 'replaced' } }),
      QUEST
    );
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  // statusMessage going quiet is how the stream signals it is no longer running.
  it('disappears once the stream stops reporting a status', () => {
    renderBubble(completion({ statusMessage: '' }), QUEST);
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  it('renders nothing without a rapid reply', () => {
    renderBubble(completion({ rapidReply: undefined }), QUEST);
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  // The streaming slot can still be held by an earlier quest - a stopped quest is never
  // handed off - so the next turn's acknowledgement must not be drawn under it.
  it('stays out of a message it does not belong to', () => {
    renderBubble(completion(), 'quest-2');
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  it('stays out of a message with no id to match against', () => {
    renderBubble(completion(), undefined);
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });
});
