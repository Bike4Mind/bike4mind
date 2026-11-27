import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const post = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...args: unknown[]) => post(...args) } }));
vi.mock('@client/app/hooks/data/settings', () => ({ useBrandingSettings: () => ({ data: undefined }) }));

import CreateSlackAppModal from './CreateSlackAppModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () => {
  const onClose = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <CreateSlackAppModal open onClose={onClose} />
    </CssVarsProvider>
  );
  return onClose;
};

describe('CreateSlackAppModal', () => {
  beforeEach(() => post.mockReset());

  it('renders in the admin dialog frame and closes on Escape when idle', () => {
    const onClose = renderModal();
    expect(screen.getByRole('dialog', { name: 'Create Slack app from manifest' })).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('create-slack-app-modal'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape and disables the close button while the create request is in flight', async () => {
    let finish: (value: unknown) => void = () => {};
    post.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const onClose = renderModal();
    fireEvent.change(screen.getByTestId('create-slack-app-token-input'), { target: { value: 'token' } });
    fireEvent.click(screen.getByTestId('create-slack-app-submit-btn'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('create-slack-app-modal-close-btn')).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByTestId('create-slack-app-modal'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({}));
  });
});
