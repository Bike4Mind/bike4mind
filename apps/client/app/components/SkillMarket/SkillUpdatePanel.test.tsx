// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISkillWithSharing } from '@client/app/hooks/data/skills';

const h = vi.hoisted(() => ({
  importListing: vi.fn(),
  detail: { data: undefined as unknown },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
vi.mock('@client/app/hooks/data/skillMarket', () => ({
  useListingDetail: () => ({ data: h.detail.data }),
  useImportListing: () => ({ mutateAsync: h.importListing, isPending: false }),
  conflictInfo: () => null,
}));
vi.mock('./parts', () => ({
  BodyDiff: () => null,
  HonestSummaryPanel: () => null,
  MismatchAlert: () => null,
}));

import SkillUpdatePanel from './SkillUpdatePanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const skill = {
  id: 'skill-1',
  name: 'fmt',
  body: 'old',
  importedFrom: { listingId: 'listing-1' },
  marketStatus: { state: 'stale', importedVersion: 1, latestVersion: 2, locallyModified: true },
} as unknown as ISkillWithSharing;

const latestDetail = {
  version: { id: 'version-2', version: 2, snapshot: { name: 'fmt', description: 'd', body: 'new' } },
};

const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SkillUpdatePanel skill={skill} />
    </CssVarsProvider>
  );

describe('SkillUpdatePanel version guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.detail.data = undefined;
    h.importListing.mockResolvedValue({ skill: { id: 'skill-1', name: 'fmt' } });
  });

  it('disables update and new-copy until the latest version has loaded', () => {
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByTestId('skill-market-confirm-overwrite'));
    expect(screen.getByTestId('skill-market-update-btn')).toBeDisabled();
    expect(screen.getByTestId('skill-market-update-new-copy-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('skill-market-update-btn'));
    expect(h.importListing).not.toHaveBeenCalled();
    unmount();
  });

  it('sends the loaded version id with an update', async () => {
    h.detail.data = latestDetail;
    renderPanel();
    fireEvent.click(screen.getByTestId('skill-market-confirm-overwrite'));
    fireEvent.click(screen.getByTestId('skill-market-update-btn'));
    await waitFor(() => expect(h.importListing).toHaveBeenCalled());
    expect(h.importListing).toHaveBeenCalledWith(
      expect.objectContaining({ targetSkillId: 'skill-1', expectedVersionId: 'version-2' })
    );
  });

  it('sends the loaded version id when saving as a new copy', async () => {
    h.detail.data = latestDetail;
    renderPanel();
    fireEvent.click(screen.getByTestId('skill-market-update-new-copy-btn'));
    await waitFor(() => expect(h.importListing).toHaveBeenCalled());
    expect(h.importListing).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'fmt-v2', expectedVersionId: 'version-2' })
    );
  });
});
