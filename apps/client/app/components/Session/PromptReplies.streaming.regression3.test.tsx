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
        messageData={{ id: 'quest-r3', sessionId: 'session-1', questMasterReply: text, status } as never}
        onSendMessage={sendMessage}
      />
    </CssVarsProvider>
  </QueryClientProvider>
);

describe('PromptReplies keeps an approved image through completion when the reply only looks cross-block', () => {
  it.each([
    ['a regex negated class in prose', 'Strip with `/[^a-z]/g` first.'],
    ['a TypeScript index signature', '```ts\ninterface Bag {\n  [key: string]: number;\n}\n```'],
    ['an HTML snippet', '```html\n<div class="card">hi</div>\n```'],
    ['a JSX snippet', '```tsx\nconst A = () => (\n<section>hi</section>\n);\n```'],
    ['an XML config snippet', '```xml\n<dependency>\n  <groupId>x</groupId>\n</dependency>\n```'],
  ])('an image approved while running stays loaded after running -> done with %s', (_, lead) => {
    const text = `${lead}\n\nHere is the chart.\n\n![chart](https://example.com/c.png)\n\nIt shows growth.`;
    const { rerender } = render(<Reply text={text} status="running" />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Reply text={text} status="done" />);
    expect(screen.queryByTestId('reply-image-load-btn')).toBeNull();
    expect(screen.getByTestId('reply-image-loaded')).toBeTruthy();
  });

  it('a retried reply (stopped -> running on the same quest) does not inherit the old approval', () => {
    const first = 'Intro.\n\n![old](https://example.com/old.png)\n\n```js\nconst x';
    const { rerender } = render(<Reply text={first} status="running" />);
    fireEvent.click(screen.getByTestId('reply-image-load-btn'));
    rerender(<Reply text={first} status="stopped" />);
    rerender(<Reply text="Again." status="running" />);
    rerender(<Reply text={'Again.\n\n![new](https://example.com/new.png)\n\nend'} status="running" />);
    expect(screen.getByTestId('reply-image-load-btn')).toBeTruthy();
    expect(screen.queryByTestId('reply-image-loaded')).toBeNull();
  });
});
