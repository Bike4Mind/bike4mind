import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DocumentationTab from './index';

const h = vi.hoisted(() => ({ openInNewTab: vi.fn() }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/utils/externalLinks', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/externalLinks')>()),
  openInNewTab: h.openInNewTab,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const DOCS = [
  {
    id: 'security-auth',
    title: 'Authentication',
    description: 'How sign-in works',
    category: 'security',
    tags: ['auth', 'mfa', 'sso', 'oauth', 'jwt'],
    docusaurusUrl: 'https://docs.example.com/security/auth',
  },
  {
    id: 'agents-intro',
    title: 'Agents overview',
    description: 'What an agent can do',
    category: 'agents',
    tags: [],
    docusaurusUrl: 'https://docs.example.com/agents',
  },
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fetchMock = vi.fn();
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const renderTab = () => render(<DocumentationTab />, { wrapper: TestWrapper });
const loaded = () => screen.findByTestId('documentation-doc-grid');

describe('DocumentationTab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok({ success: true, docs: DOCS }));
    vi.stubGlobal('fetch', fetchMock);
    h.openInNewTab.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens with the page header: the Docs h1 and the doc count', async () => {
    renderTab();
    await loaded();
    const root = screen.getByTestId('admin-documentation-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(root.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent('Docs (2)');
  });

  it('shows a loading state on the first load, then the docs', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise(r => (resolve = r)));
    renderTab();
    expect(screen.getByTestId('documentation-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('documentation-updating')).toBeNull();
    resolve(ok({ success: true, docs: DOCS }));
    await loaded();
    expect(screen.queryByTestId('documentation-loading')).toBeNull();
    expect(screen.getByTestId('documentation-doc-security-auth')).toHaveTextContent('Authentication');
  });

  it('renders no emoji and only neutral chips', async () => {
    renderTab();
    await loaded();
    expect(document.body.textContent).not.toMatch(PICTOGRAPHIC);
    const category = screen.getByTestId('documentation-doc-security-auth-category');
    expect(category).toHaveTextContent('Security');
    const chips = screen.getByTestId('documentation-doc-security-auth').querySelectorAll('.MuiChip-root');
    expect(chips.length).toBe(5);
    chips.forEach(chip => expect(chip).toHaveClass('MuiChip-colorNeutral'));
    expect(screen.getByTestId('documentation-doc-security-auth')).toHaveTextContent('+2 more');
  });

  it('filters by category tab and by search', async () => {
    renderTab();
    await loaded();
    fireEvent.click(screen.getByTestId('documentation-category-tabs-agents-btn'));
    expect(screen.getByTestId('documentation-category-tabs-agents-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('documentation-doc-security-auth')).toBeNull();
    expect(screen.getByTestId('documentation-doc-agents-intro')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('documentation-category-tabs-all-btn'));
    fireEvent.change(screen.getByTestId('documentation-search-input'), { target: { value: 'mfa' } });
    expect(screen.getByTestId('documentation-doc-security-auth')).toBeInTheDocument();
    expect(screen.queryByTestId('documentation-doc-agents-intro')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Docs (1)');
  });

  it('names the search in the empty state and clears it', async () => {
    renderTab();
    await loaded();
    fireEvent.change(screen.getByTestId('documentation-search-input'), { target: { value: 'nothing here' } });
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No docs match "nothing here"');
    fireEvent.click(screen.getByTestId('documentation-empty-clear-search-btn'));
    expect(screen.getByTestId('documentation-search-input')).toHaveValue('');
    expect(screen.getByTestId('documentation-doc-security-auth')).toBeInTheDocument();
  });

  it('names an empty category and offers to show every doc', async () => {
    renderTab();
    await loaded();
    fireEvent.click(screen.getByTestId('documentation-category-tabs-migration-btn'));
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No docs in Migration');
    fireEvent.click(screen.getByTestId('documentation-empty-show-all-btn'));
    expect(screen.getByTestId('documentation-category-tabs-all-btn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('documentation-doc-agents-intro')).toBeInTheDocument();
  });

  it('says no docs site is configured when the metadata comes back empty, with a refresh action', async () => {
    fetchMock.mockResolvedValue(ok({ success: true, docs: [] }));
    renderTab();
    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No docs found');
    expect(empty).toHaveTextContent('This deployment has no docs site configured.');
    fetchMock.mockResolvedValue(ok({ success: true, docs: DOCS }));
    fireEvent.click(screen.getByTestId('documentation-empty-refresh-btn'));
    await loaded();
  });

  it('shows an error state when the first load fails, and retries', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ success: false }) });
    renderTab();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Docs failed to load.');
    expect(screen.queryByTestId('admin-empty-state')).toBeNull();
    fetchMock.mockResolvedValue(ok({ success: true, docs: DOCS }));
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    await loaded();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
  });

  it('keeps the docs on screen while a refresh runs and when it fails', async () => {
    renderTab();
    await loaded();
    let reject: (reason: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    fireEvent.click(screen.getByTestId('documentation-refresh-btn'));
    expect(screen.getByTestId('documentation-updating')).toBeInTheDocument();
    expect(screen.queryByTestId('documentation-loading')).toBeNull();
    expect(screen.getByTestId('documentation-doc-security-auth')).toBeInTheDocument();

    reject(new Error('network down'));
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('network down');
    expect(screen.queryByTestId('documentation-updating')).toBeNull();
    expect(screen.getByTestId('documentation-doc-security-auth')).toBeInTheDocument();
  });

  it('opens a doc in a new tab', async () => {
    renderTab();
    await loaded();
    fireEvent.click(screen.getByTestId('documentation-doc-agents-intro-open-btn'));
    expect(h.openInNewTab).toHaveBeenCalledWith('https://docs.example.com/agents');
  });
});
