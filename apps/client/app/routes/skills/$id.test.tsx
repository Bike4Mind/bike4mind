// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const ORG = { id: 'org1', name: 'Acme Labs' };
const approvedListing = {
  id: 'l1',
  sourceSkillId: 's1',
  visibility: 'organization',
  organizationId: ORG.id,
  currentApprovedVersionId: 'v1',
  claudePluginName: 'hello-team-abc123',
  name: 'Hello Team',
};

const h = vi.hoisted(() => ({
  skill: {} as Record<string, unknown>,
  listings: [] as Array<Record<string, unknown>>,
  orgs: [] as Array<{ id: string; name: string }>,
  enabled: [] as Array<boolean | undefined>,
  pending: false,
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: 's1' }) }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'u1' } }) }));
vi.mock('@client/app/hooks/data/skills', () => ({
  useGetSkill: () => ({ data: h.skill, isLoading: false }),
  useDeleteSkill: () => ({ mutateAsync: vi.fn() }),
}));
// Like React Query, the mocks return cached data even while disabled, so the page's own guard is what filters it.
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMyListings: (opts: { enabled?: boolean }) => {
    h.enabled.push(opts.enabled);
    return { data: h.listings, isPending: h.pending };
  },
  useMarketMe: () => ({ data: { organizations: h.orgs }, isPending: h.pending }),
}));
vi.mock('@client/app/components/SkillsManagement/SkillShareDialog', () => ({ default: () => null }));
vi.mock('@client/app/components/SkillMarket/SkillUpdatePanel', () => ({ default: () => null }));
vi.mock('@client/app/components/SkillMarket/PublishDialog', () => ({ default: () => null }));
vi.mock('@client/app/components/SkillMarket/MarketStatusBadge', () => ({ default: () => null }));
vi.mock('@client/app/components/SkillsManagement/ClaudeCodeExportDialog', () => ({
  default: ({ marketplace }: { marketplace?: unknown }) => (
    <div data-testid="claude-code-dialog-marketplace">{JSON.stringify(marketplace ?? null)}</div>
  ),
}));

import SkillDetailPage from './$id';

const appTheme = extendTheme({ ...getThemeConfig() });

const openDialog = () => {
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillDetailPage />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
  return JSON.parse(screen.getByTestId('claude-code-dialog-marketplace').textContent ?? '');
};

describe('SkillDetailPage team marketplace', () => {
  beforeEach(() => {
    h.skill = { id: 's1', userId: 'u1', name: 'hello-team', description: 'd', body: 'b' };
    h.listings = [approvedListing];
    h.orgs = [ORG];
    h.enabled = [];
    h.pending = false;
  });

  it('passes the approved org listing to the dialog for the owner', () => {
    expect(openDialog()).toEqual({ org: ORG, pluginName: 'hello-team-abc123', skillName: 'Hello Team' });
  });

  it('fetches listings only once the dialog opens', () => {
    openDialog();
    expect(h.enabled[0]).toBe(false);
    expect(h.enabled.at(-1)).toBe(true);
  });

  it('holds the dialog until the listings load', () => {
    h.pending = true;
    render(
      <CssVarsProvider theme={appTheme}>
        <SkillDetailPage />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    expect(screen.queryByTestId('claude-code-dialog-marketplace')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-btn')).toBeDisabled();
  });

  it('still offers the tab when the listing has no plugin name yet', () => {
    h.listings = [{ ...approvedListing, claudePluginName: undefined }];
    expect(openDialog()).toEqual({ org: ORG, skillName: 'Hello Team' });
  });

  it.each([
    ['no listing', () => (h.listings = [])],
    ['a public listing', () => (h.listings = [{ ...approvedListing, visibility: 'public' }])],
    ['an unlisted listing', () => (h.listings = [{ ...approvedListing, visibility: 'unlisted' }])],
    [
      'a pending-only listing',
      () => (h.listings = [{ ...approvedListing, currentApprovedVersionId: null, claudePluginName: undefined }]),
    ],
    ['a listing of another skill', () => (h.listings = [{ ...approvedListing, sourceSkillId: 's2' }])],
    ['an org the viewer left', () => (h.orgs = [])],
    ['an imported skill', () => (h.skill = { ...h.skill, importedFrom: { listingId: 'l9', version: 1 } })],
    ['a skill the viewer does not own', () => (h.skill = { ...h.skill, userId: 'u2' })],
  ])('passes no marketplace for %s', (_case, arrange) => {
    arrange();
    expect(openDialog()).toBeNull();
  });
});
