import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxType, type IInboxDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  inbox: [] as Record<string, unknown>[],
}));

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { push: h.push } }) }));
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

import Messages, { InboxDisplayModal } from './Messages';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const item = (overrides: Partial<IInboxDocument> = {}) =>
  ({
    id: 'i1',
    userId: 'SYSTEM',
    receiverId: 'me',
    type: InboxType.LOOP,
    title: 'Loop "Digest" paused',
    message: 'Out of credits',
    readAt: null,
    deletedAt: null,
    link: '/loops/abc?run=exec-1',
    ...overrides,
  }) as IInboxDocument;

const renderModal = (inbox: IInboxDocument, onClose = vi.fn(), onReply = vi.fn()) => {
  render(
    <TestWrapper>
      <InboxDisplayModal
        open
        inbox={inbox}
        onClose={onClose}
        onReply={onReply}
        showReplyInput={false}
        replyMessage=""
        onReplyMessageChange={vi.fn()}
        onReplySubmit={vi.fn()}
        onReplyCancel={vi.fn()}
        sendLoading={false}
      />
    </TestWrapper>
  );
  return { onClose, onReply };
};

beforeEach(() => vi.clearAllMocks());

describe('InboxDisplayModal', () => {
  it('offers Open and no Reply on a linked SYSTEM notice, and Open closes then navigates', () => {
    const { onClose } = renderModal(item());
    expect(screen.queryByTestId('inbox-message-reply-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-open-link-btn'));
    expect(onClose).toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith('/loops/abc?run=exec-1');
  });

  it('offers Reply and no Open on a user message', () => {
    renderModal(item({ userId: 'friend', link: undefined }));
    expect(screen.getByTestId('inbox-message-reply-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-open-link-btn')).toBeNull();
  });

  it('ignores a link that is not app-relative', () => {
    renderModal(item({ link: '//evil.example/x' }));
    expect(screen.queryByTestId('inbox-open-link-btn')).toBeNull();
  });
});

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
