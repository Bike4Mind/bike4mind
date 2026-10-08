import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import FileBrowserFilter from './Filter';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderFilter = (type?: 'video') => {
  const onChange = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <FileBrowserFilter value={type ? { filters: { type } } : undefined} onChange={onChange} />
    </CssVarsProvider>
  );
  return onChange;
};

const openTypeSelect = () => fireEvent.click(screen.getByRole('combobox'));

describe('FileBrowserFilter file type', () => {
  it('emits type video when Video is selected', () => {
    const onChange = renderFilter();
    openTypeSelect();
    fireEvent.click(screen.getByRole('option', { name: 'Video' }));
    expect(onChange).toHaveBeenCalledWith({ filters: { type: 'video' } });
  });

  it('clears the type when all is selected', () => {
    const onChange = renderFilter('video');
    openTypeSelect();
    fireEvent.click(screen.getByRole('option', { name: 'All Files Type' }));
    expect(onChange).toHaveBeenCalledWith({ filters: { type: undefined } });
  });
});
