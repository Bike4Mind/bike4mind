import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { toast } from 'sonner';
import { ShareableEntity } from '@bike4mind/common';
import ShareModal from './ShareModal';

const h = vi.hoisted(() => ({ updateSharingOnServer: vi.fn() }));

vi.mock('@client/app/utils/sharingApi', () => ({ updateSharingOnServer: h.updateSharingOnServer }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const entity = { id: 'file-1', name: 'Notes', isGlobalRead: false, isGlobalWrite: false } as ShareableEntity;

const renderModal = () =>
  render(
    <TestWrapper>
      <ShareModal open onClose={vi.fn()} shareableEntity={entity} entityType="files" onUpdate={vi.fn()} />
    </TestWrapper>
  );

describe('ShareModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // Global read/write is gated on the SHARE predicate, so an update-without-share holder can be
  // refused here legitimately. axios resolves isAxiosError by property, not prototype, which is why
  // a plain object with the flag is a faithful stand-in for a real rejection.
  it('surfaces the servers reason for a refused global share, not axios own status line', async () => {
    h.updateSharingOnServer.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only a share holder can publish globally' } },
      })
    );

    renderModal();
    fireEvent.click(screen.getByTestId('share-modal-global-read-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only a share holder can publish globally'));
  });

  // `api` is a bare axios.create() with no response interceptor, so this is the string the toast
  // showed before: technically an Error message, and useless to the person reading it.
  it('does not fall back to the axios message when the envelope carries a reason', async () => {
    h.updateSharingOnServer.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        isAxiosError: true,
        response: { status: 403, data: { error: 'Only a share holder can publish globally' } },
      })
    );

    renderModal();
    fireEvent.click(screen.getByTestId('share-modal-global-write-btn'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalledWith('Request failed with status code 403');
  });
});
