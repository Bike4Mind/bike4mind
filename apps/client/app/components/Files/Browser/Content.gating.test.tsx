import React, { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Gating coverage for the Files browser's "Data Lakes" upload-menu entry: the
 * option must be hidden when EnableDataLakes is off - otherwise it opens the
 * Data Lake manager panel, whose lakes query 403s (FEATURE_DISABLED) and whose
 * empty state is a dead end. Exercises UploadDropdown (the desktop entry in
 * Content.tsx); the mobile call site passes the same gated prop.
 */

vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useCreateFabFile: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteFiles: () => ({ mutate: vi.fn(), isPending: false }),
  usePaginatedSearchFabFiles: vi.fn(),
}));

vi.mock('../../Knowledge/CreateKnowledgeFromUrl', () => ({ default: () => null }));

vi.mock('../../Knowledge/KnowledgeModal', () => {
  const state = { setOpen: vi.fn(), setSelectedFabFileId: vi.fn(), setViewOnly: vi.fn() };
  return { useKnowledgeModal: (selector: (s: typeof state) => unknown) => selector(state) };
});

// Default (flag on) is established in beforeEach; tests override per-case.
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

import { UploadDropdown } from './Content';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function renderAndOpenUploadMenu() {
  render(
    <TestWrapper>
      <UploadDropdown isLoading={false} />
    </TestWrapper>
  );
  fireEvent.click(screen.getByRole('combobox'));
}

describe('UploadDropdown - EnableDataLakes gating', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
  });

  it('shows the Data Lakes option when the feature is on', () => {
    renderAndOpenUploadMenu();

    expect(screen.getByText('Data Lakes')).toBeInTheDocument();
  });

  it('hides the Data Lakes option when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenUploadMenu();

    expect(screen.queryByText('Data Lakes')).not.toBeInTheDocument();
  });

  it('keeps the other upload actions available when the feature is off', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    renderAndOpenUploadMenu();

    expect(screen.getByText('From device')).toBeInTheDocument();
    expect(screen.getByText('Add from URL')).toBeInTheDocument();
    expect(screen.getByText('Create Knowledge')).toBeInTheDocument();
  });
});
