import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate, mutateAsync } = vi.hoisted(() => ({ navigate: vi.fn(), mutateAsync: vi.fn() }));

vi.mock('@client/app/hooks/data/customPages', () => ({
  useCreateCustomPage: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import NewCustomPageDialog from './NewCustomPageDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderDialog = (onClose = vi.fn()) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <NewCustomPageDialog open onClose={onClose} />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue({ id: 'new1' });
});

describe('NewCustomPageDialog', () => {
  it('disables submit until a name is entered', () => {
    renderDialog();
    expect(screen.getByTestId('new-page-submit-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-page-name-input'), { target: { value: 'Menu' } });
    expect(screen.getByTestId('new-page-submit-btn')).not.toBeDisabled();
  });

  it('creates the page and navigates to it', async () => {
    const onClose = vi.fn();
    renderDialog(onClose);
    fireEvent.change(screen.getByTestId('new-page-name-input'), { target: { value: '  Menu ' } });
    fireEvent.click(screen.getByTestId('new-page-submit-btn'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/pages/$id', params: { id: 'new1' } }));
    expect(mutateAsync).toHaveBeenCalledWith({ name: 'Menu' });
    expect(onClose).toHaveBeenCalled();
  });
});
