import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FallbackLakeSettingsModal } from './FallbackLakeSettingsModal';

const updateMutate = vi.fn();

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useUpdateFallbackLakeSettings: () => ({ mutate: updateMutate, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = { id: 'opti-knowledge', name: 'OptiHashi Knowledge', groundingMode: 'retrieve' as const };

beforeEach(() => {
  updateMutate.mockClear();
});

describe('FallbackLakeSettingsModal', () => {
  it('renders nothing (closed) when no lake is being edited', () => {
    render(<FallbackLakeSettingsModal lake={null} onClose={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('fallback-lake-settings-modal')).not.toBeInTheDocument();
  });

  it('seeds the grounding-mode picker from the lake and saves the CHANGED value only', async () => {
    const user = userEvent.setup();
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.getByTestId('fallback-lake-grounding-mode-button')).toHaveTextContent('Retrieve (recommended)');

    await user.click(screen.getByTestId('fallback-lake-grounding-mode-button'));
    await user.click(screen.getByTestId('fallback-lake-grounding-mode-inline'));
    await user.click(screen.getByTestId('fallback-lake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'opti-knowledge', groundingMode: 'inline' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('does NOT offer name/description/visibility/gate fields - a fallback lake has no document for them', () => {
    render(<FallbackLakeSettingsModal lake={lake} onClose={vi.fn()} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('datalake-settings-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-settings-visibility')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-settings-usertag')).not.toBeInTheDocument();
  });

  it('closes without saving on Cancel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<FallbackLakeSettingsModal lake={lake} onClose={onClose} />, { wrapper: Wrapper });

    await user.click(screen.getByText('Cancel'));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
