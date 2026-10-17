import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate, setOpen } = vi.hoisted(() => ({ navigate: vi.fn(), setOpen: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/components/Files/Browser/instanceContext', () => ({
  useFileBrowserInstance: () => ({ setOpen }),
}));

import GenerateAudioButton from './GenerateAudioButton';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('GenerateAudioButton', () => {
  it('closes the file browser and opens the Studio speech tab', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <GenerateAudioButton />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('file-browser-generate-audio-btn'));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(navigate).toHaveBeenCalledWith({ to: '/studio/$modality', params: { modality: 'speech' } });
  });
});
