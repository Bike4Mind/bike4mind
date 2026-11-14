import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import Messages from './Messages';

const h = vi.hoisted(() => ({
  inbox: [] as Record<string, unknown>[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: { currentUser: { id: string } }) => unknown) => {
    const state = { currentUser: { id: 'owner1' } };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@client/app/hooks/data/inbox', () => ({
  useGetInbox: () => ({ data: h.inbox, isLoading: false }),
  useReadInboxItems: () => ({ mutate: vi.fn() }),
  useSendInboxitem: () => ({ mutate: vi.fn() }),
  useDeleteInbox: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

describe('Messages', () => {
  it('lists an org alert from SYSTEM and opens it without a Reply action', () => {
    h.inbox = [
      {
        id: 'alert1',
        userId: 'SYSTEM',
        receiverId: 'owner1',
        type: 'common',
        title: 'Acme: budget alert',
        message: 'Acme has used 80% of its 10,000 credit monthly budget.',
        createdAt: new Date(),
        readAt: null,
      },
    ];
    render(<Messages />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByText('Acme: budget alert'));

    // Once in the list preview, once in the opened message.
    expect(screen.getAllByText('Acme has used 80% of its 10,000 credit monthly budget.')).toHaveLength(2);
    expect(screen.queryByTestId('inbox-message-reply-btn')).toBeNull();
  });

  it('still offers Reply on a message from a person', () => {
    h.inbox = [
      {
        id: 'msg1',
        userId: 'u2',
        sender: { id: 'u2', name: 'Pat' },
        receiverId: 'owner1',
        type: 'common',
        title: 'Hello there',
        message: 'Hi',
        createdAt: new Date(),
        readAt: null,
      },
    ];
    render(<Messages />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByText('Hello there'));

    expect(screen.getByTestId('inbox-message-reply-btn')).toBeTruthy();
  });
});
