import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ListingDetail as ListingDetailData } from '@client/app/hooks/data/skillMarket';
import { SKILL_MD_THIRD_PARTY_NOTE } from '@bike4mind/common/utils/skillMd';
import ListingDetail from './ListingDetail';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const hooks = vi.hoisted(() => ({
  detail: vi.fn(),
  mutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  me: undefined as { organizations: Array<{ id: string; name: string }> } | undefined,
}));

vi.mock('@client/app/hooks/data/skillMarket', () => ({
  conflictInfo: () => null,
  useListingDetail: hooks.detail,
  useImportListing: hooks.mutation,
  useRateListing: hooks.mutation,
  useReportListing: hooks.mutation,
  useModerateListing: hooks.mutation,
  useMarketMe: () => ({ data: hooks.me }),
}));
vi.mock('@client/app/components/SkillsManagement/ClaudeCodeMarketplaceTab', () => ({
  default: (props: unknown) => <div data-testid="marketplace-tab-props">{JSON.stringify(props)}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const snapshot = {
  name: 'review-pr',
  description: 'Review a PR',
  body: 'Review $ARGUMENTS.',
  allowedTools: [],
};

const makeData = (overrides: Partial<ListingDetailData> = {}): ListingDetailData => ({
  listing: {
    id: 'l1',
    name: 'review-pr',
    description: 'Review a PR',
    authorName: 'a Bike4Mind user',
    visibility: 'unlisted',
    status: 'approved',
    hiddenByReports: false,
    shareToken: 'secret',
    autoChecked: true,
    riskTier: 'clean',
    ratingAvg: 5,
    ratingCount: 1,
    importCount: 2,
    currentVersion: 1,
    tags: [],
  },
  version: { id: 'v1', version: 1, snapshot, createdAt: '2026-01-01' } as ListingDetailData['version'],
  ratings: [],
  myImport: null,
  viewer: {
    isAuthor: false,
    canReview: false,
    canDelist: false,
    canRestore: false,
    canImport: true,
    canRate: false,
  },
  similar: [],
  ...overrides,
});

const writeText = vi.fn();

const renderListing = (data: ListingDetailData, token = 'secret') => {
  hooks.detail.mockReturnValue({ data, isLoading: false, isError: false });
  return render(
    <CssVarsProvider theme={appTheme}>
      <ListingDetail listingId="l1" token={token} />
    </CssVarsProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  hooks.me = undefined;
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('ListingDetail Claude Code tools card', () => {
  it('lists the Claude Code tools the skill declares', () => {
    const version = {
      ...makeData().version!,
      snapshot: { ...snapshot, claudeCodeAllowedTools: ['Bash(git:*)', 'Read'] },
    };
    renderListing(makeData({ version }));
    const card = screen.getByTestId('market-claude-code-tools');
    expect(card).toHaveTextContent('Bash(git:*)');
    expect(card).toHaveTextContent('Read');
  });

  it('omits the card when the skill declares none', () => {
    renderListing(makeData());
    expect(screen.queryByTestId('market-claude-code-tools')).not.toBeInTheDocument();
  });
});

describe('ListingDetail "Use in Claude Code"', () => {
  it('exports the reviewed version without the unlisted share token', async () => {
    renderListing(makeData());
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    fireEvent.click(await screen.findByTestId('skill-claude-code-copy-cmd'));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const command: string = writeText.mock.calls[0][0];
    expect(command).toContain(`${window.location.origin}/skills/market/l1`);
    expect(command).toContain('Review $ARGUMENTS.');
    expect(command).not.toContain('secret');
    expect(command).not.toContain('token=');
    expect(command).toContain(SKILL_MD_THIRD_PARTY_NOTE);
    expect(screen.getByText(/third-party skill/)).toBeInTheDocument();
    expect(screen.getByTestId('skill-claude-code-import-hint')).toBeInTheDocument();
  });

  it('treats the author as the owner: no third-party framing and no import hint', async () => {
    renderListing(makeData({ viewer: { ...makeData().viewer, isAuthor: true, canImport: false, canDelist: true } }));
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    fireEvent.click(await screen.findByTestId('skill-claude-code-copy-cmd'));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).not.toContain(SKILL_MD_THIRD_PARTY_NOTE);
    expect(screen.queryByText(/third-party skill/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-import-hint')).not.toBeInTheDocument();
  });

  it('hides the import hint when the viewer cannot import the listing', () => {
    renderListing(makeData({ viewer: { ...makeData().viewer, canImport: false } }));
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    expect(screen.getByText(/third-party skill/)).toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-import-hint')).not.toBeInTheDocument();
  });

  it('hides the export when the listing has no reviewed snapshot', () => {
    renderListing(makeData({ version: null }));
    expect(screen.queryByTestId('skill-claude-code-btn')).not.toBeInTheDocument();
  });

  it('hides the import hint once the viewer has imported the skill', () => {
    renderListing(
      makeData({ myImport: { version: 1, skill: { id: 's1', name: 'review-pr' } } as ListingDetailData['myImport'] })
    );
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    expect(screen.getByTestId('skill-claude-code-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-claude-code-import-hint')).not.toBeInTheDocument();
  });

  it('passes the org listing name to the team marketplace tab', () => {
    hooks.me = { organizations: [{ id: 'org1', name: 'Acme Labs' }] };
    const data = makeData();
    renderListing(
      makeData({
        listing: {
          ...data.listing,
          name: 'Hello Team',
          visibility: 'organization',
          organizationId: 'org1',
          claudePluginName: 'hello-team-abc123',
        },
      })
    );
    fireEvent.click(screen.getByTestId('skill-claude-code-btn'));
    fireEvent.click(screen.getByTestId('skill-claude-code-tab-marketplace'));
    expect(JSON.parse(screen.getByTestId('marketplace-tab-props').textContent ?? '')).toEqual({
      org: { id: 'org1', name: 'Acme Labs' },
      pluginName: 'hello-team-abc123',
      skillName: 'Hello Team',
    });
  });
});
