import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { InboxType, type IInboxDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ history: { push: h.push } }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'me' } }) }));
vi.mock('@client/app/hooks/data/inbox', () => ({
  useGetInbox: () => ({ data: [] }),
  useReadInboxItems: () => ({ mutate: vi.fn() }),
  useSendInboxitem: () => ({ mutate: vi.fn() }),
  useDeleteInbox: () => ({ mutate: vi.fn() }),
}));
vi.mock('./SenderInfoModal', () => ({ default: () => null }));

import { InboxDisplayModal } from './Messages';

const appTheme = extendTheme({ ...getThemeConfig() });

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
    <CssVarsProvider theme={appTheme}>
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
    </CssVarsProvider>
  );
  return { onClose, onReply };
};

beforeEach(() => vi.clearAllMocks());

describe('InboxDisplayModal', () => {
  it('offers Open and no Reply on a linked SYSTEM notice, and Open closes then navigates', () => {
    const { onClose } = renderModal(item());
    expect(screen.queryByTestId('inbox-reply-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('inbox-open-link-btn'));
    expect(onClose).toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith('/loops/abc?run=exec-1');
  });

  it('offers Reply and no Open on a user message', () => {
    renderModal(item({ userId: 'friend', link: undefined }));
    expect(screen.getByTestId('inbox-reply-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-open-link-btn')).toBeNull();
  });

  it('ignores a link that is not app-relative', () => {
    renderModal(item({ link: '//evil.example/x' }));
    expect(screen.queryByTestId('inbox-open-link-btn')).toBeNull();
  });
});
