import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import FileBrowserFilter from './Filter';
import GeneratedFilterToggle, { toggleGeneratedTag } from './GeneratedFilterToggle';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('toggleGeneratedTag', () => {
  it('adds the generated tag next to the selected ones', () => {
    expect(toggleGeneratedTag(['work'])).toEqual(['work', 'generated']);
  });

  it('removes it in any case, keeping the other tags', () => {
    expect(toggleGeneratedTag(['work', 'Generated'])).toEqual(['work']);
  });
});

describe('GeneratedFilterToggle', () => {
  it('is pressed while the generated tag is selected', () => {
    render(<GeneratedFilterToggle tags={['generated']} onTagsChange={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByTestId('file-browser-generated-filter-btn').getAttribute('aria-pressed')).toBe('true');
  });

  it('works icon-only in the mobile row', () => {
    const onTagsChange = vi.fn();
    render(<GeneratedFilterToggle tags={undefined} onTagsChange={onTagsChange} compact />, { wrapper: Wrapper });
    const button = screen.getByRole('button', { name: 'Generated' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onTagsChange).toHaveBeenCalledWith(['generated']);
  });
});

describe('FileBrowserFilter generated quick filter', () => {
  it('selects the generated tag, keeping the type filter', () => {
    const onChange = vi.fn();
    render(<FileBrowserFilter value={{ filters: { type: 'audio' } }} onChange={onChange} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    expect(onChange).toHaveBeenCalledWith({ filters: { type: 'audio', tags: ['generated'] } });
  });

  it('clears only the generated tag', () => {
    const onChange = vi.fn();
    render(<FileBrowserFilter value={{ filters: { tags: ['work', 'generated'] } }} onChange={onChange} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    expect(onChange).toHaveBeenCalledWith({ filters: { tags: ['work'] } });
  });
});
