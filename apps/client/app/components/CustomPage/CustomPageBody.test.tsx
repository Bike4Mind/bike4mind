import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ICustomPageDocument, PageWidget } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import CustomPageBody, { sortWidgets } from './CustomPageBody';

const mocks = vi.hoisted(() => ({ toggle: vi.fn(), remove: vi.fn() }));
vi.mock('@client/app/hooks/data/customPages', () => ({
  useToggleChecklistItem: () => ({ mutate: mocks.toggle }),
  useRemovePageWidget: () => ({ mutate: mocks.remove }),
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-viewer">{content}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makePage = (widgets: PageWidget[]): ICustomPageDocument => ({
  id: 'a'.repeat(24),
  userId: 'u1',
  name: 'Daily menu',
  description: 'What to eat today',
  state: {},
  widgets,
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomPageBody', () => {
  it('shows the empty state when the page has no widgets', () => {
    render(<CustomPageBody page={makePage([])} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('custom-page-title').textContent).toBe('Daily menu');
    expect(screen.getByTestId('custom-page-empty').textContent).toContain('Tell the assistant what this page is for');
  });

  it('renders each widget type in order and ignores unknown types', () => {
    const unknown = { id: 'weird', type: 'chart', order: 0 } as unknown as PageWidget;
    const widgets: PageWidget[] = [
      { id: 'recipe', type: 'markdown', title: 'Recipe', markdown: '# Shakshuka', order: 2 },
      { id: 'cookable', type: 'card-list', title: 'Cookable', items: [{ id: 'c1', title: 'Fried rice' }], order: 1 },
      { id: 'shopping-list', type: 'checklist', items: [{ id: 'eggs', label: 'Eggs', checked: false }] },
      unknown,
    ];
    render(<CustomPageBody page={makePage(widgets)} />, { wrapper: TestWrapper });

    const ids = screen.getAllByTestId(/^page-widget-card-/).map(el => el.getAttribute('data-testid'));
    expect(ids).toEqual([
      'page-widget-card-weird',
      'page-widget-card-cookable',
      'page-widget-card-recipe',
      'page-widget-card-shopping-list',
    ]);
    expect(screen.getByTestId('page-card-item-c1').textContent).toContain('Fried rice');
    expect(screen.getByTestId('markdown-viewer').textContent).toBe('# Shakshuka');
    expect(screen.getByTestId('page-widget-card-weird').textContent).toBe('');
  });

  it('toggles a checklist item through the mutation', () => {
    const widgets: PageWidget[] = [
      { id: 'shopping-list', type: 'checklist', items: [{ id: 'eggs', label: 'Eggs', checked: false }] },
    ];
    render(<CustomPageBody page={makePage(widgets)} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('page-checklist-item-eggs'));
    expect(mocks.toggle).toHaveBeenCalledWith(
      { widgetId: 'shopping-list', itemId: 'eggs', checked: true },
      expect.any(Object)
    );
  });

  it('removes a widget from its menu', async () => {
    const widgets: PageWidget[] = [{ id: 'recipe', type: 'markdown', markdown: 'x' }];
    render(<CustomPageBody page={makePage(widgets)} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('page-widget-menu-btn-recipe'));
    fireEvent.click(await screen.findByTestId('page-widget-remove-btn-recipe'));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('recipe', expect.any(Object)));
  });

  it('sorts widgets with an order first and keeps stored order otherwise', () => {
    const widgets: PageWidget[] = [
      { id: 'a', type: 'markdown', markdown: '' },
      { id: 'b', type: 'markdown', markdown: '', order: 5 },
      { id: 'c', type: 'markdown', markdown: '' },
      { id: 'd', type: 'markdown', markdown: '', order: 1 },
    ];
    expect(sortWidgets(widgets).map(w => w.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});
