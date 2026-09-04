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

const completion = (over: Record<string, unknown> = {}) =>
  ({
    statusMessage: 'Running...',
    rapidReply: { content: 'Give me a moment.', status: 'streaming' },
    ...over,
  }) as unknown as BubbleProps['chatCompletion'];

const renderBubble = (chatCompletion: BubbleProps['chatCompletion']) =>
  render(
    <TestWrapper>
      <RapidReplyBubble chatCompletion={chatCompletion} />
    </TestWrapper>
  );

describe('RapidReplyBubble', () => {
  it('renders the acknowledgement while the real answer is still running', () => {
    renderBubble(completion());
    expect(screen.getByTestId('rapid-reply-container')).toHaveTextContent('Give me a moment.');
  });

  // 'replaced' means the real answer superseded it; keeping it would leave the user
  // reading a stale placeholder above the answer that replaced it.
  it('disappears once the real reply has replaced it', () => {
    renderBubble(completion({ rapidReply: { content: 'Give me a moment.', status: 'replaced' } }));
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  // statusMessage going quiet is how the stream signals it is no longer running.
  it('disappears once the stream stops reporting a status', () => {
    renderBubble(completion({ statusMessage: '' }));
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });

  it('renders nothing without a completion or a rapid reply', () => {
    renderBubble(undefined);
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
    renderBubble(completion({ rapidReply: undefined }));
    expect(screen.queryByTestId('rapid-reply-container')).toBeNull();
  });
});
