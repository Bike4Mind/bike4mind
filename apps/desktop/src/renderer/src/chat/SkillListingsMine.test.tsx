// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillMyListing } from '@shared/skillMarket';
import { SkillListingsMine } from './SkillListingsMine';

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

const row = (overrides: Partial<SkillMyListing> = {}): SkillMyListing => ({
  id: 'l1',
  name: 'tester-guide',
  visibility: 'public',
  status: 'approved',
  hiddenByReports: false,
  tags: ['qa'],
  currentVersion: 2,
  hasShareLink: false,
  ...overrides,
});

let listings: SkillMyListing[] = [];
const market = {
  mine: vi.fn(async () => ({ listings })),
  withdraw: vi.fn(async () => {
    listings = listings.map(listing => (listing.id === 'l1' ? { ...listing, status: 'withdrawn' } : listing));
    return { ok: true as const };
  }),
  copyShareLink: vi.fn(async () => ({ ok: true as const })),
  openOnWeb: vi.fn(async () => true),
  pickUploadSource: vi.fn(async () => ({ ok: false as const, error: '', canceled: true })),
};
(window as unknown as { b4m: unknown }).b4m = { skillMarket: market };

let root: Root;
const render = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CssVarsProvider>
        <SkillListingsMine />
      </CssVarsProvider>
    )
  );
};
const $ = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="skill-listing-row"]')];

describe('SkillListingsMine', () => {
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('shows status, versions, tags, and a share link only for unlisted listings', async () => {
    listings = [
      row(),
      row({
        id: 'l2',
        name: 'linky',
        visibility: 'unlisted',
        hasShareLink: true,
        status: 'in_review',
        pendingVersion: 1,
      }),
      row({
        id: 'l3',
        name: 'hidden',
        hiddenByReports: true,
        latest: { version: 3, reviewStatus: 'rejected', reviewNote: 'Too vague' },
      }),
    ];
    await render();
    const [first, second, third] = rows();
    expect($('skill-listing-status', first)?.textContent).toBe('Live');
    expect(first.textContent).toContain('live: v2');
    expect(first.textContent).toContain('#qa');
    expect($('skill-listing-copy-link-btn', first)).toBeNull();

    expect($('skill-listing-status', second)?.textContent).toBe('In review');
    expect(second.textContent).toContain('in review: v1');
    await act(async () => $('skill-listing-copy-link-btn', second)?.click());
    expect(market.copyShareLink).toHaveBeenCalledWith('l2');

    expect($('skill-listing-status', third)?.textContent).toBe('Hidden (reported)');
    expect(third.textContent).toContain('Reviewer note: Too vague');
  });

  it('withdraws only after the in-app confirm, then shows the row withdrawn without actions', async () => {
    listings = [row()];
    await render();
    await act(async () => $('skill-listing-withdraw-btn')?.click());
    expect($('skill-listing-withdraw-confirm')?.textContent).toContain(
      'Withdraw /tester-guide from the market? People who imported it keep their copies.'
    );
    expect(market.withdraw).not.toHaveBeenCalled();

    await act(async () => $('skill-listing-withdraw-confirm-btn')?.click());
    expect(market.withdraw).toHaveBeenCalledWith('l1');
    const [withdrawn] = rows();
    expect($('skill-listing-status', withdrawn)?.textContent).toBe('Withdrawn');
    expect($('skill-listing-withdraw-btn', withdrawn)).toBeNull();
    expect($('skill-listing-new-version-btn', withdrawn)).toBeNull();
  });

  it('shows the sign-in prompt when signed out', async () => {
    market.mine.mockResolvedValueOnce({ listings: [], error: 'Sign in to browse the Skill Market.' } as never);
    await render();
    expect($('skill-market-mine-error')?.textContent).toContain('Sign in');
  });
});
