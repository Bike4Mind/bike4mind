import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import FileBrowserFilter from './Filter';
import GeneratedFilterToggle from './GeneratedFilterToggle';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('GeneratedFilterToggle', () => {
  it('is pressed while active and turns off on click', () => {
    const onChange = vi.fn();
    render(<GeneratedFilterToggle active onChange={onChange} />, { wrapper: Wrapper });
    const button = screen.getByTestId('file-browser-generated-filter-btn');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('works icon-only in the mobile row', () => {
    const onChange = vi.fn();
    render(<GeneratedFilterToggle active={false} onChange={onChange} compact />, { wrapper: Wrapper });
    const button = screen.getByRole('button', { name: 'generated_filter.label' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('FileBrowserFilter generated quick filter', () => {
  it('sets the generated filter, keeping the type and tag filters', () => {
    const onChange = vi.fn();
    render(<FileBrowserFilter value={{ filters: { type: 'audio', tags: ['work'] } }} onChange={onChange} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    expect(onChange).toHaveBeenCalledWith({ filters: { type: 'audio', tags: ['work'], generated: true } });
  });

  it('clears the generated filter without touching the tags', () => {
    const onChange = vi.fn();
    render(<FileBrowserFilter value={{ filters: { tags: ['work'], generated: true } }} onChange={onChange} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByTestId('file-browser-generated-filter-btn'));
    expect(onChange).toHaveBeenCalledWith({ filters: { tags: ['work'], generated: undefined } });
  });
});
