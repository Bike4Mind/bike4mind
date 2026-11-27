import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input, Option, Select } from '@mui/joy';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// jsdom applies no stylesheet to ::before or to custom properties, so this reads the rules out of
// globals.css and matches their selectors against the DOM Joy really renders, in each focus state.

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

type Rule = { selectors: string[]; declarations: string };

const parseRules = (css: string): Rule[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectorList, declarations]) => ({
    selectors: selectorList.split(',').map(selector => selector.trim()),
    declarations,
  }));

const rules = parseRules(readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8'));

/** Selectors of every rule whose body matches `declaration`. */
const selectorsDeclaring = (declaration: RegExp) =>
  rules.filter(rule => declaration.test(rule.declarations)).flatMap(rule => rule.selectors);

const OPACITY_ZERO = /(^|[;\s])opacity:\s*0\s*!important/;
const transparentHighlight = (field: 'Select' | 'Input') =>
  new RegExp(`--${field}-focusedHighlight:\\s*transparent\\s*!important`);

/** Joy draws the ring on the root's ::before, so `opacity: 0` there hides it. Returned without the pseudo-element. */
const hiddenBefore = (field: 'Select' | 'Input') =>
  selectorsDeclaring(OPACITY_ZERO)
    .filter(selector => selector.endsWith('::before') && selector.includes(field))
    .map(selector => selector.replace(/::before$/, ''));

/** Every selector that blanks the ring, by hiding the ::before or by making its color transparent. */
const hidingSelectors = (field: 'Select' | 'Input') => [
  ...hiddenBefore(field),
  ...selectorsDeclaring(transparentHighlight(field)),
];

const matchesAny = (element: Element, selectors: string[]) => selectors.some(selector => element.matches(selector));

// Emotion labels class names (`JoySelect-root`) in dev and test builds only; production keeps just
// the `MuiSelect-root` class. Both shapes are checked.
const asProduction = (element: Element) => {
  const copy = element.cloneNode(false) as HTMLElement;
  copy.className = [...element.classList].filter(name => !name.includes('Joy')).join(' ');
  return copy;
};

// A root that holds focus itself, so `:focus` matches it and not only `:focus-within`.
const focusedRoot = (element: Element) => {
  const copy = element.cloneNode(false) as HTMLElement;
  copy.tabIndex = -1;
  document.body.appendChild(copy);
  copy.focus();
  return copy;
};

const renderFields = () => {
  render(
    <TestWrapper>
      <Select data-testid="select" slotProps={{ button: { 'data-testid': 'select-button' } }} defaultValue="a">
        <Option value="a">Alpha</Option>
        <Option value="b">Beta</Option>
      </Select>
      <Input data-testid="input" slotProps={{ input: { 'data-testid': 'input-field' } }} />
    </TestWrapper>
  );
  return {
    select: screen.getByTestId('select'),
    selectButton: screen.getByTestId('select-button'),
    input: screen.getByTestId('input'),
    inputField: screen.getByTestId('input-field'),
  };
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Select focus ring in globals.css', () => {
  it('finds the rules that blank the ring, so a parser that matches nothing cannot pass', () => {
    expect(hidingSelectors('Select').some(selector => selector.includes('MuiSelect-root'))).toBe(true);
    expect(hidingSelectors('Select').some(selector => selector.startsWith("[class*='JoySelect']"))).toBe(true);
    expect(hidingSelectors('Input').some(selector => selector.includes('JoyInput'))).toBe(true);
  });

  it('puts Mui-focusVisible on the Select root after Tab, and not after a mouse click', async () => {
    const user = userEvent.setup();
    const mouse = renderFields();
    await user.click(mouse.selectButton);
    expect(mouse.select).not.toHaveClass('Mui-focusVisible');

    cleanup();
    const keyboard = renderFields();
    await user.tab();
    expect(keyboard.selectButton).toHaveFocus();
    expect(keyboard.select).toHaveClass('Mui-focusVisible');
    expect(keyboard.selectButton).not.toHaveClass('Mui-focusVisible');
  });

  it('does not blank the ring of a Select that has keyboard focus', async () => {
    const user = userEvent.setup();
    const { select } = renderFields();
    await user.tab();
    expect(select).toHaveClass('Mui-focusVisible');

    const hiding = hidingSelectors('Select');
    expect(matchesAny(select, hiding)).toBe(false);
    expect(matchesAny(asProduction(select), hiding)).toBe(false);
    expect(matchesAny(focusedRoot(select), hiding)).toBe(false);
  });

  it('still blanks the ring of a Select that was focused with the mouse', async () => {
    const user = userEvent.setup();
    const { select, selectButton } = renderFields();
    await user.click(selectButton);
    expect(select).not.toHaveClass('Mui-focusVisible');

    expect(matchesAny(select, hiddenBefore('Select'))).toBe(true);
    expect(matchesAny(asProduction(select), hiddenBefore('Select'))).toBe(true);
    expect(matchesAny(select, selectorsDeclaring(transparentHighlight('Select')))).toBe(true);
  });

  it('keeps blanking the Input ring while it has keyboard focus', async () => {
    const user = userEvent.setup();
    const { input, inputField } = renderFields();
    await user.tab();
    await user.tab();
    expect(inputField).toHaveFocus();

    expect(matchesAny(input, hiddenBefore('Input'))).toBe(true);
    expect(matchesAny(input, selectorsDeclaring(transparentHighlight('Input')))).toBe(true);
  });
});
