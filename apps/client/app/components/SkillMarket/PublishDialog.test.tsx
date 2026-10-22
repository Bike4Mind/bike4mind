import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISkill, ISkillListingVersion } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  publish: vi.fn(),
  rescan: vi.fn(),
  navigate: vi.fn(),
  suggest: vi.fn((_skillId: string, _enabled?: boolean) => ({
    data: undefined as string[] | undefined,
    isFetching: false,
  })),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMarketMe: () => ({ data: { organizations: [{ id: 'org-1', name: 'Acme' }], isReviewer: false, isAdmin: false } }),
  usePublishSkill: () => ({ mutateAsync: h.publish, isPending: false }),
  useRescanVersion: () => ({ mutateAsync: h.rescan, isPending: false }),
  useSuggestListingTags: (skillId: string, enabled?: boolean) => h.suggest(skillId, enabled),
}));

import PublishDialog from './PublishDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const skill = { id: 'skill-1', name: 'fmt', description: 'Formats text', body: 'b' } as ISkill;

const version = (overrides: Partial<ISkillListingVersion>): ISkillListingVersion =>
  ({
    id: 'v1',
    listingId: 'l1',
    version: 1,
    snapshot: { name: 'fmt', description: 'Formats text', body: 'b' },
    contentHash: 'h',
    scanStatus: 'passed',
    scanFindings: [],
    reviewStatus: 'auto_approved',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ISkillListingVersion;

const renderDialog = (props: Partial<React.ComponentProps<typeof PublishDialog>> = { skill }) => {
  const ui = (p: typeof props) => (
    <CssVarsProvider theme={appTheme}>
      <PublishDialog onClose={vi.fn()} {...p} />
    </CssVarsProvider>
  );
  const r = render(ui(props));
  return { ...r, rerender: () => r.rerender(ui(props)) };
};

const suggestions = (bySkill: Record<string, string[]>) =>
  h.suggest.mockImplementation((skillId: string) => ({ data: bySkill[skillId], isFetching: false }));

describe('PublishDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.suggest.mockImplementation(() => ({ data: undefined, isFetching: false }));
  });

  it('shows why a failed scan did not publish, with each finding', async () => {
    h.publish.mockResolvedValue({
      listing: { id: 'l1', visibility: 'public', status: 'rejected' },
      version: version({
        scanStatus: 'failed',
        reviewStatus: 'not_required',
        scanFindings: [
          {
            rule: 'prompt_injection',
            severity: 'critical',
            message: 'Tries to override or discard prior/system instructions',
            excerpt: 'Ignore all previous instructions',
            source: 'rules',
          },
        ],
      }),
    });
    renderDialog();
    fireEvent.click(screen.getByTestId('market-publish-submit-btn'));

    await waitFor(() => expect(screen.getByTestId('market-scan-failed')).toBeInTheDocument());
    expect(screen.getByTestId('market-scan-failed')).toHaveTextContent('Not published');
    expect(screen.getByTestId('market-findings')).toHaveTextContent(
      'Tries to override or discard prior/system instructions'
    );
    expect(screen.getByTestId('market-findings')).toHaveTextContent('Ignore all previous instructions');
    expect(screen.queryByTestId('market-publish-view-btn')).toBeNull();
    expect(h.publish).toHaveBeenCalledWith({ skillId: 'skill-1', visibility: 'public', tags: [] });
  });

  it.each(['public', 'organization', 'unlisted'] as const)(
    'shows a pending %s result with the honest summary and a mismatch warning',
    async visibility => {
      h.publish.mockResolvedValue({
        listing: { id: 'l1', visibility, status: 'in_review' },
        version: version({
          riskTier: 'review',
          reviewStatus: 'pending',
          honestSummary: {
            whatItDoes: 'Posts your text to a service.',
            toolsUsed: [],
            dataItTouches: 'Your text',
            riskNotes: [],
            descriptionMatches: false,
            mismatchNote: 'Says it formats text but uploads it.',
          },
        }),
      });
      renderDialog();
      fireEvent.click(screen.getByTestId('market-publish-submit-btn'));

      await waitFor(() =>
        expect(screen.getByTestId('market-scan-passed')).toHaveTextContent('Waiting for a human reviewer')
      );
      expect(screen.getByTestId('market-scan-passed')).toHaveTextContent(
        'Listings with findings are checked by a person before they go live.'
      );
      expect(screen.getByTestId('market-honest-summary')).toHaveTextContent('Posts your text to a service.');
      expect(screen.getByTestId('market-mismatch-alert')).toHaveTextContent('Says it formats text but uploads it.');
      expect(screen.queryByTestId('market-publish-view-btn')).toBeNull();
    }
  );

  it('offers a retry when the scan errored (fail closed)', async () => {
    h.publish.mockResolvedValue({
      listing: { id: 'l1', visibility: 'public', status: 'in_review' },
      version: version({ scanStatus: 'error', reviewStatus: 'not_required' }),
    });
    h.rescan.mockResolvedValue({ version: version({}) });
    renderDialog();
    fireEvent.click(screen.getByTestId('market-publish-submit-btn'));

    await waitFor(() => expect(screen.getByTestId('market-rescan-btn')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('market-rescan-btn'));
    await waitFor(() => expect(screen.getByTestId('market-scan-passed')).toBeInTheDocument());
    expect(h.rescan).toHaveBeenCalledWith('v1');
  });

  it('requires an organization before an Organization listing can be submitted', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('market-publish-visibility-organization'));
    expect(screen.getByTestId('market-publish-submit-btn')).toBeDisabled();
  });

  it('discloses the reviewer hold for every visibility, not only Public', () => {
    renderDialog();
    expect(
      screen.getByText(/At every visibility, the scan can reject a submission or hold it for a reviewer/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Held for a reviewer if the scan flags anything/)).toBeNull();
  });

  describe('tag suggestions', () => {
    beforeEach(() =>
      h.publish.mockResolvedValue({
        listing: { id: 'l1', visibility: 'public', status: 'approved' },
        version: version({}),
      })
    );

    it('prefills the suggested tags and publishes them', async () => {
      suggestions({ 'skill-1': ['writing', 'formatting'] });
      renderDialog();
      expect(h.suggest).toHaveBeenCalledWith('skill-1', true);
      expect(screen.getByTestId('market-publish-tag-writing')).toBeInTheDocument();
      expect(screen.getByTestId('market-publish-tag-formatting')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('market-publish-submit-btn'));
      await waitFor(() =>
        expect(h.publish).toHaveBeenCalledWith({
          skillId: 'skill-1',
          visibility: 'public',
          tags: ['writing', 'formatting'],
        })
      );
    });

    it('publishes only the suggestions the author kept', async () => {
      suggestions({ 'skill-1': ['writing', 'formatting'] });
      renderDialog();
      fireEvent.click(screen.getByTestId('market-publish-tag-delete-writing'));
      expect(screen.queryByTestId('market-publish-tag-writing')).toBeNull();
      fireEvent.click(screen.getByTestId('market-publish-submit-btn'));
      await waitFor(() =>
        expect(h.publish).toHaveBeenCalledWith({ skillId: 'skill-1', visibility: 'public', tags: ['formatting'] })
      );
    });

    it('does not overwrite tags the author edited when suggestions arrive later', async () => {
      const { rerender } = renderDialog();
      const input = screen.getByTestId('market-publish-tag-input');
      fireEvent.change(input, { target: { value: 'mine' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      suggestions({ 'skill-1': ['writing'] });
      rerender();
      expect(screen.getByTestId('market-publish-tag-mine')).toBeInTheDocument();
      expect(screen.queryByTestId('market-publish-tag-writing')).toBeNull();
      fireEvent.click(screen.getByTestId('market-publish-submit-btn'));
      await waitFor(() =>
        expect(h.publish).toHaveBeenCalledWith({ skillId: 'skill-1', visibility: 'public', tags: ['mine'] })
      );
    });

    it('replaces the suggestions when the author picks another skill before editing', async () => {
      suggestions({ 'skill-1': ['writing'], 'skill-2': ['sql'] });
      const other = { id: 'skill-2', name: 'q', description: 'Queries', body: 'b' } as ISkill;
      renderDialog({ ownSkills: [skill, other] });
      fireEvent.click(screen.getByTestId('market-publish-skill-select'));
      fireEvent.click(await screen.findByRole('option', { name: '/fmt' }));
      expect(await screen.findByTestId('market-publish-tag-writing')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('market-publish-skill-select'));
      fireEvent.click(await screen.findByRole('option', { name: '/q' }));
      expect(await screen.findByTestId('market-publish-tag-sql')).toBeInTheDocument();
      expect(screen.queryByTestId('market-publish-tag-writing')).toBeNull();
    });

    it('shows a hint while suggestions load', () => {
      h.suggest.mockImplementation(() => ({ data: undefined, isFetching: true }));
      renderDialog();
      expect(screen.getByTestId('market-publish-tags-suggesting')).toHaveTextContent('Suggesting tags...');
    });
  });
});
