// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
const mocks = vi.hoisted(() => ({
  user: { isAdmin: false, adminPermissions: ['credits:adjust'] } as { isAdmin: boolean; adminPermissions: string[] },
  dialog: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.user }) }));
vi.mock('../InviteCenter/Pending/usePendingBulkActions', () => ({ MAX_PENDING_BULK: 100 }));
vi.mock('../InviteCenter/Pending/PendingBulkDialog', async () => {
  const { ActionDialog } = await import('./ActionDialog');
  return {
    PendingBulkDialog: (props: { kind: string; userIds: string[] }) => {
      mocks.dialog(props);
      return (
        <ActionDialog
          open
          onClose={() => undefined}
          title="Review future grants"
          reasonPresets={['Verified review']}
          confirmLabel="Confirm block"
          onConfirm={mocks.submit}
          data-testid="confirm-test-block"
        />
      );
    },
  };
});
import { ReviewGroupGrantsButton } from './ReviewGroupGrantsButton';
const theme = extendTheme({ ...getThemeConfig() });
const renderButton = (outer = vi.fn(), incomplete = false) =>
  render(
    <CssVarsProvider theme={theme}>
      <form onSubmit={outer}>
        <ReviewGroupGrantsButton userIds={['account-a', 'account-b', 'account-a']} incomplete={incomplete} />
      </form>
    </CssVarsProvider>
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { isAdmin: false, adminPermissions: ['credits:adjust'] };
});

describe('manual group grant review', () => {
  it('opens only a preview for the exact deduplicated participants after a click', () => {
    renderButton();
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('review-group-grants-btn'));
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'block', userIds: ['account-a', 'account-b'] })
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('does not submit a parent verdict form when the portaled grant form is confirmed', () => {
    const outer = vi.fn();
    renderButton(outer);
    fireEvent.click(screen.getByTestId('review-group-grants-btn'));
    fireEvent.click(screen.getByTestId('confirm-test-block-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('confirm-test-block-confirm-btn'));
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
  it('hides the action without credit permission', () => {
    mocks.user.adminPermissions = ['support:read'];
    renderButton();
    expect(screen.queryByTestId('review-group-grants-btn')).toBeNull();
  });
  it('does not offer a bulk action for incomplete membership', () => {
    renderButton(vi.fn(), true);
    expect(screen.queryByTestId('review-group-grants-btn')).toBeNull();
  });
});
