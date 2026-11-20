// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import SignupHoneypot from './SignupHoneypot';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('SignupHoneypot', () => {
  it('renders an unfocusable, autofill-off input named hp_ref_x', () => {
    wrap(<SignupHoneypot value="" onChange={() => {}} />);
    const input = screen.getByTestId('signup-honeypot-input');
    expect(input.getAttribute('name')).toBe('hp_ref_x');
    expect(input.getAttribute('tabindex')).toBe('-1');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });

  it('opts out of password managers', () => {
    wrap(<SignupHoneypot value="" onChange={() => {}} />);
    const input = screen.getByTestId('signup-honeypot-input');
    expect(input.hasAttribute('data-1p-ignore')).toBe(true);
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(input.hasAttribute('data-bwignore')).toBe(true);
    expect(input.getAttribute('data-form-type')).toBe('other');
  });

  it('hides the wrapper from assistive tech and positions it off-screen without display:none', () => {
    wrap(<SignupHoneypot value="" onChange={() => {}} />);
    const wrapper = screen.getByTestId('signup-honeypot');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    const style = getComputedStyle(wrapper);
    expect(style.position).toBe('absolute');
    expect(style.left).toBe('-10000px');
    expect(style.width).toBe('1px');
    expect(style.height).toBe('1px');
    expect(style.overflow).toBe('hidden');
    expect(style.display).not.toBe('none');
  });

  it('reports typed values', () => {
    const onChange = vi.fn();
    wrap(<SignupHoneypot value="" onChange={onChange} />);
    fireEvent.change(screen.getByTestId('signup-honeypot-input'), { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledWith('x');
  });
});
