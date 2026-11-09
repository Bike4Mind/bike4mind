import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailCategory } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  templates: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailTemplates: () => mocks.templates,
  useEmailJobs: () => ({ data: { data: [] } }),
  useDeleteEmailTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloneEmailTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./EmailTemplateEditor', () => ({
  default: ({ templateId }: { templateId?: string }) => (
    <div data-testid="email-template-editor-stub" data-template-id={templateId ?? 'new'} />
  ),
}));

import EmailTemplatesPanel from './EmailTemplatesPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailTemplatesPanel />
    </CssVarsProvider>
  );

const template = {
  id: 't1',
  name: 'Welcome',
  slug: 'welcome',
  category: EmailCategory.MARKETING,
  subject: 'Hello there',
  isActive: true,
};

describe('EmailTemplatesPanel', () => {
  beforeEach(() => {
    Object.assign(mocks.templates, { data: { data: [] }, isLoading: false, isError: false });
    mocks.templates.refetch.mockClear();
  });

  it('starts with a toolbar row that holds only the new template button', () => {
    const { container } = renderPanel();
    const toolbar = container.firstElementChild?.firstElementChild as HTMLElement;

    expect(Array.from(toolbar.children)).toEqual([screen.getByTestId('new-template-btn')]);
    expect(screen.getByTestId('new-template-btn')).toHaveTextContent('New template');
  });

  it('adds no inset of its own, so the table lines up with the page title', () => {
    const { container } = renderPanel();

    expect(getComputedStyle(container.firstElementChild as HTMLElement).paddingLeft).toBe('0');
  });

  it('shows the loading state while templates load', () => {
    mocks.templates.isLoading = true;
    renderPanel();

    expect(screen.getByTestId('email-templates-loading')).toHaveTextContent('Loading templates');
  });

  it('shows an error state whose retry refetches the templates', () => {
    Object.assign(mocks.templates, { data: undefined, isError: true });
    renderPanel();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load templates.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.templates.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows on screen when a background refetch fails', () => {
    Object.assign(mocks.templates, { data: { data: [template] }, isError: true });
    renderPanel();

    expect(screen.getByTestId('edit-template-t1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('shows an empty state whose action opens a new template in the editor', () => {
    renderPanel();

    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No templates yet');
    fireEvent.click(within(empty).getByTestId('email-templates-empty-create-btn'));
    expect(screen.getByTestId('email-template-editor-stub')).toHaveAttribute('data-template-id', 'new');
  });

  it('lists templates and opens one for editing', () => {
    mocks.templates.data = { data: [template] };
    renderPanel();

    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-template-t1'));
    expect(screen.getByTestId('email-template-editor-stub')).toHaveAttribute('data-template-id', 't1');
  });
});
