import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import EmailTemplateEditor from './EmailTemplateEditor';

// The editor syncs form state from `existingTemplate` in an effect, so the mocked hooks must return
// referentially stable values or every render re-fires it.
const m = vi.hoisted(() => ({
  template: {
    id: 't1',
    name: 'Welcome',
    slug: 'welcome',
    subject: 'Hi {{userName}}',
    htmlContent: '<p>Hello {{userName}}</p>',
    category: 'marketing',
    isActive: true,
  },
  query: { data: undefined as unknown, isLoading: false },
  mutation: { mutateAsync: () => Promise.resolve(), isPending: false },
}));
m.query.data = m.template;

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailTemplate: () => m.query,
  useCreateEmailTemplate: () => m.mutation,
  useUpdateEmailTemplate: () => m.mutation,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderEditor = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailTemplateEditor templateId="t1" existingSlugs={[]} onBack={() => {}} onSaved={() => {}} />
    </CssVarsProvider>
  );

// jsdom's getComputedStyle ignores @media rules, so read the declarations emitted for the element's
// classes inside the `min-width` query for a breakpoint (0px is the phone-first base, 900px is md).
const declared = (testId: string, minWidth: string) => {
  const classes = Array.from(screen.getByTestId(testId).classList);
  const found: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (
        !(rule instanceof CSSMediaRule) ||
        !rule.conditionText.replace(/\s/g, '').includes(`(min-width:${minWidth})`)
      ) {
        continue;
      }
      for (const inner of Array.from(rule.cssRules)) {
        if (!(inner instanceof CSSStyleRule) || !classes.some(c => inner.selectorText === `.${c}`)) continue;
        for (const name of Array.from(inner.style)) found[name] = inner.style.getPropertyValue(name);
      }
    }
  }
  return found;
};

describe('EmailTemplateEditor', () => {
  it('stacks the form and preview columns on a narrow window and splits them 50/50 from md up', () => {
    renderEditor();

    expect(declared('email-template-editor-columns', '0px')['flex-direction']).toBe('column');
    expect(declared('email-template-editor-form-column', '0px')).toMatchObject({ width: '100%' });
    expect(declared('email-template-editor-preview-column', '0px')).toMatchObject({ width: '100%' });

    expect(declared('email-template-editor-columns', '900px')['flex-direction']).toBe('row');
    expect(declared('email-template-editor-form-column', '900px')).toMatchObject({ width: '50%' });
    expect(declared('email-template-editor-preview-column', '900px')).toMatchObject({ width: '50%' });
  });

  it('hides the drag divider while stacked and shows it from md up', () => {
    renderEditor();

    expect(declared('email-template-editor-divider', '0px')['display']).toBe('none');
    expect(declared('email-template-editor-divider', '900px')['display']).toBe('flex');
  });

  it('lets the header and preview header wrap so their buttons cannot force a sideways scroll', () => {
    renderEditor();

    expect(getComputedStyle(screen.getByTestId('email-template-editor-header')).flexWrap).toBe('wrap');
    expect(getComputedStyle(screen.getByTestId('email-template-editor-preview-header')).flexWrap).toBe('wrap');
  });

  it('scrolls the stacked columns as one and lets the columns shrink below their content width', () => {
    renderEditor();

    expect(declared('email-template-editor-columns', '0px')['overflow-y']).toBe('auto');
    expect(declared('email-template-editor-columns', '900px')['overflow-y']).toBe('hidden');
    expect(getComputedStyle(screen.getByTestId('email-template-editor-form-column')).minWidth).toBe('0px');
    expect(getComputedStyle(screen.getByTestId('email-template-editor-preview-column')).minWidth).toBe('0px');
  });
});
