// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SkillMarketDetail,
  SkillMarketDetailResult,
  SkillMarketImportRequest,
  SkillMarketImportResult,
  SkillMarketListing,
  SkillMarketPage,
} from '@shared/skillMarket';
import { SkillMarketPanel } from './SkillMarketPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const card: SkillMarketListing = {
  id: 'l1',
  name: 'guide-for-testers',
  description: 'Writes a tester guide.',
  authorName: 'Ana',
  visibility: 'public',
  status: 'approved',
  tags: [],
  ratingAvg: 4.5,
  ratingCount: 2,
  importCount: 1,
};

const detail = (overrides: Partial<SkillMarketDetail> = {}): SkillMarketDetail => ({
  listing: card,
  version: {
    id: 'v2',
    version: 2,
    snapshot: { name: 'guide-for-testers', description: 'd', body: 'Write the guide.', allowedTools: ['web_fetch'] },
    honestSummary: {
      whatItDoes: 'Drafts a test guide from a PR.',
      toolsUsed: [],
      dataItTouches: 'The PR text',
      riskNotes: [],
      descriptionMatches: true,
    },
    riskTier: 'clean',
    createdAt: '',
  },
  myImport: null,
  canImport: true,
  ...overrides,
});

const browse = vi.fn<(filters: unknown, page: number) => Promise<SkillMarketPage>>();
const recommended = vi.fn<() => Promise<SkillMarketPage>>();
const listing = vi.fn<() => Promise<SkillMarketDetailResult>>();
const importListing = vi.fn<(request: SkillMarketImportRequest) => Promise<SkillMarketImportResult>>();
const openOnWeb = vi.fn(async () => true);

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  for (const mock of [browse, recommended, listing, importListing, openOnWeb]) mock.mockReset();
  browse.mockResolvedValue({ listings: [card], hasMore: false });
  recommended.mockResolvedValue({ listings: [], hasMore: false });
  listing.mockResolvedValue({ detail: detail() });
  (window as unknown as { b4m: unknown }).b4m = {
    skillMarket: { browse, recommended, listing, importListing, openOnWeb, imports: vi.fn() },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(initial?: { id: string }): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider>
        <SkillMarketPanel onClose={() => {}} initial={initial} />
      </CssVarsProvider>
    );
  });
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(id: string): Promise<void> {
  await act(async () => {
    byTestId(id)?.click();
  });
}

describe('SkillMarketPanel', () => {
  it('lists the market and opens a listing with its safety summary, requested tools and body', async () => {
    await mount();
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ sort: 'top' }), 1);
    expect(byTestId('skill-market-card')?.textContent).toContain('/guide-for-testers');

    await click('skill-market-card');
    expect(listing).toHaveBeenCalledWith({ id: 'l1' });
    expect(byTestId('skill-listing-summary')?.textContent).toContain('Drafts a test guide from a PR.');
    expect(byTestId('skill-listing-tools')?.textContent).toContain('Requested tools (not enforced)');
    expect(byTestId('skill-listing-tools')?.textContent).toContain('web_fetch');
    expect(byTestId('skill-listing-body')?.textContent).toBe('Write the guide.');
  });

  it('shows the sign-in error instead of a list when signed out', async () => {
    browse.mockResolvedValue({ listings: [], hasMore: false, error: 'Sign in to browse the Skill Market.' });
    await mount();
    expect(byTestId('skill-market-error')?.textContent).toContain('Sign in');
    expect(byTestId('skill-market-card')).toBeNull();
  });

  it('pages with Load more', async () => {
    browse.mockResolvedValueOnce({ listings: [card], hasMore: true });
    browse.mockResolvedValueOnce({ listings: [{ ...card, id: 'l2', name: 'second' }], hasMore: false });
    await mount();
    await click('skill-market-more-btn');
    expect(browse).toHaveBeenLastCalledWith(expect.anything(), 2);
    expect(document.querySelectorAll('[data-testid="skill-market-card"]')).toHaveLength(2);
  });

  it('imports, and offers a rename on a name collision instead of overwriting', async () => {
    importListing
      .mockResolvedValueOnce({
        ok: false,
        error: 'You already have a skill named "x"',
        code: 'name_taken',
        suggestedName: 'guide-2',
      })
      .mockResolvedValueOnce({ ok: true, skill: { id: 's1', name: 'guide-2' } });
    await mount({ id: 'l1' });

    await click('skill-listing-import-btn');
    expect(importListing).toHaveBeenLastCalledWith({ listingId: 'l1' });
    const input = byTestId('skill-listing-rename-input') as HTMLInputElement;
    expect(input.value).toBe('guide-2');

    await click('skill-listing-rename-btn');
    expect(importListing).toHaveBeenLastCalledWith({ listingId: 'l1', name: 'guide-2' });
    expect(byTestId('skill-listing-notice')?.textContent).toContain('Imported as /guide-2');
  });

  it('offers an update with its diff, and confirms in-app before replacing local edits', async () => {
    listing.mockResolvedValue({
      detail: detail({
        myImport: { version: 1, skill: { id: 's1', name: 'guide-for-testers' } },
        update: {
          skillId: 's1',
          fromVersion: 1,
          toVersion: 2,
          versionId: 'v2',
          diff: { path: 'guide-for-testers', operation: 'edit', added: 1, removed: 1, lines: [] },
          toolsAdded: ['web_fetch'],
          toolsRemoved: [],
          locallyModified: true,
        },
      }),
    });
    importListing.mockResolvedValue({ ok: true, skill: { id: 's1', name: 'guide-for-testers' } });
    const confirm = vi.spyOn(window, 'confirm');
    await mount({ id: 'l1' });

    expect(byTestId('skill-update-offer')?.textContent).toContain('v1 to v2');
    expect(byTestId('skill-update-tools')?.textContent).toContain('+web_fetch');
    expect(byTestId('skill-listing-import-btn')).toBeNull();

    await click('skill-update-apply-btn');
    expect(importListing).not.toHaveBeenCalled();
    await click('skill-overwrite-confirm-btn');
    expect(importListing).toHaveBeenCalledWith({
      listingId: 'l1',
      targetSkillId: 's1',
      expectedVersionId: 'v2',
      overwrite: true,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('opens the listing on the web from main', async () => {
    await mount({ id: 'l1' });
    await click('skill-listing-web-btn');
    expect(openOnWeb).toHaveBeenCalledWith({ kind: 'listing', id: 'l1' });
  });
});
