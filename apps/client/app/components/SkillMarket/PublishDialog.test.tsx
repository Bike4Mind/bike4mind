import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISkill, ISkillListingVersion } from '@bike4mind/common';

const h = vi.hoisted(() => ({ publish: vi.fn(), rescan: vi.fn(), navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useMarketMe: () => ({ data: { organizations: [{ id: 'org-1', name: 'Acme' }], isReviewer: false, isAdmin: false } }),
  usePublishSkill: () => ({ mutateAsync: h.publish, isPending: false }),
  useRescanVersion: () => ({ mutateAsync: h.rescan, isPending: false }),
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

const renderDialog = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <PublishDialog onClose={vi.fn()} skill={skill} />
    </CssVarsProvider>
  );

describe('PublishDialog', () => {
  beforeEach(() => vi.clearAllMocks());

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

  it('shows a live result with the honest summary and a mismatch warning', async () => {
    h.publish.mockResolvedValue({
      listing: { id: 'l1', visibility: 'organization', status: 'approved' },
      version: version({
        riskTier: 'review',
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

    await waitFor(() => expect(screen.getByTestId('market-scan-passed')).toHaveTextContent('Live on the Skill Market'));
    expect(screen.getByTestId('market-honest-summary')).toHaveTextContent('Posts your text to a service.');
    expect(screen.getByTestId('market-mismatch-alert')).toHaveTextContent('Says it formats text but uploads it.');
    expect(screen.getByTestId('market-publish-view-btn')).toBeInTheDocument();
  });

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
});
