import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IUserDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { useUser } from '@client/app/contexts/UserContext';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import StorageLimitNotice from './StorageLimitNotice';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderNotice = (props: React.ComponentProps<typeof StorageLimitNotice>) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <StorageLimitNotice {...props} />
    </CssVarsProvider>
  );

// 1 MB limit, stored in MB like the real user document.
const setUsage = (currentStorageSize: number) =>
  useUser.setState({ currentUser: { currentStorageSize, storageLimit: 1 } as IUserDocument });

describe('StorageLimitNotice', () => {
  afterEach(() => {
    useUser.setState({ currentUser: null });
    useFileBrowser.setState({ open: false });
  });

  it('renders nothing for a user comfortably under the limit', () => {
    setUsage(0);
    const { container } = renderNotice({ uploadBytes: 1000 });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a non-blocking warning near the limit', () => {
    setUsage(850_000);
    renderNotice({ uploadBytes: 100_000 });
    expect(screen.getByTestId('storage-limit-near-alert')).toBeInTheDocument();
  });

  it('shows usage, limit and what to free when the upload does not fit', () => {
    setUsage(1_000_000);
    renderNotice({ uploadBytes: 2000 });
    expect(screen.getByTestId('storage-limit-exceeded-alert')).toHaveTextContent(
      'you are using 1 MB of 1 MB, and this upload needs 2 kB. Free up at least 2 kB'
    );
  });

  it('opens the file browser from Manage files, unless the caller overrides it', () => {
    setUsage(1_000_000);
    const { unmount } = renderNotice({ uploadBytes: 1 });
    fireEvent.click(screen.getByTestId('storage-limit-manage-files-btn'));
    expect(useFileBrowser.getState().open).toBe(true);
    unmount();

    useFileBrowser.setState({ open: false });
    const onManageFiles = vi.fn();
    renderNotice({ uploadBytes: 1, onManageFiles });
    fireEvent.click(screen.getByTestId('storage-limit-manage-files-btn'));
    expect(onManageFiles).toHaveBeenCalledOnce();
    expect(useFileBrowser.getState().open).toBe(false);
  });
});
