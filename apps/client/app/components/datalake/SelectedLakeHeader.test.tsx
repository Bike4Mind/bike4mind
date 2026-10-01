import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import SelectedLakeHeader from './SelectedLakeHeader';
import { DATA_LAKES, type ManageableDataLakeConfig } from '@bike4mind/common';

// The strip's two buttons are its whole reason to exist, and both are store writers - so the
// store is a real spy pair rather than a partial stub. A stub missing one of these makes the
// corresponding click throw "is not a function", which a presence-only assertion cannot see.
const { openWizardForLake, openManager } = vi.hoisted(() => ({
  openWizardForLake: vi.fn(),
  openManager: vi.fn(),
}));
vi.mock('@client/app/stores/useDataLakeWizardStore', async importOriginal => ({
  // Keep the real toWizardTargetLake: it is a pure projection, and stubbing it would hide a
  // drifted field from every caller this suite covers.
  ...(await importOriginal<typeof import('@client/app/stores/useDataLakeWizardStore')>()),
  useDataLakeWizardStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ openWizardForLake, openManager }),
}));

// DriveConnectAction fetches Drive status; this suite owns the strip's own wiring, not that chain.
vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({
  default: () => <div data-testid="drive-connect-action" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = (over: Partial<ManageableDataLakeConfig> = {}): ManageableDataLakeConfig =>
  ({
    id: 'lake-1',
    slug: 'ops',
    name: 'Ops Lake',
    fileTagPrefix: 'ops:',
    datalakeTag: 'datalake:ops',
    requiredUserTag: undefined,
    requiredEntitlement: undefined,
    organizationId: 'org-1',
    isOwn: true,
    canRebuild: false,
    canManage: true,
    ...over,
  }) as ManageableDataLakeConfig;

const renderHeader = (over: Partial<ManageableDataLakeConfig> = {}) =>
  render(
    <Wrapper>
      <SelectedLakeHeader lake={lake(over)} />
    </Wrapper>
  );

beforeEach(() => {
  openWizardForLake.mockClear();
  openManager.mockClear();
});

describe('SelectedLakeHeader', () => {
  it('opens the append wizard targeting the scoped lake', () => {
    renderHeader();

    fireEvent.click(screen.getByTestId('datalake-selected-lake-addfiles-btn'));

    expect(openWizardForLake).toHaveBeenCalledTimes(1);
    // The wizard needs the lake's identity AND its tagging rules, or the append lands untagged.
    expect(openWizardForLake).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake-1', slug: 'ops', name: 'Ops Lake', fileTagPrefix: 'ops:' })
    );
  });

  it('deep-links Configure to the manager with this lake preselected', () => {
    renderHeader();

    fireEvent.click(screen.getByTestId('datalake-selected-lake-manage-btn'));

    expect(openManager).toHaveBeenCalledWith('mine', 'lake-1');
  });

  it('withholds Add files on a lake the caller cannot manage, keeping Configure', () => {
    renderHeader({ canManage: false });

    expect(screen.queryByTestId('datalake-selected-lake-addfiles-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-selected-lake-manage-btn')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-selected-lake-prefix')).toHaveTextContent('ops:');
  });

  it('offers the Drive control only on an org lake the caller manages', () => {
    renderHeader();
    expect(screen.getByTestId('datalake-selected-lake-source')).toBeInTheDocument();
  });

  it.each([
    ['a personal lake', { organizationId: undefined }],
    ['an org lake the caller cannot manage', { canManage: false }],
  ])('withholds the Drive control on %s', (_label, over) => {
    // Server-side a personal lake has no org to hold a connection and the status route 404s for a
    // non-manager, so a control here could only ever fail.
    renderHeader(over as Partial<ManageableDataLakeConfig>);
    expect(screen.queryByTestId('datalake-selected-lake-source')).not.toBeInTheDocument();
  });

  it('marks a lake chat cannot search, and only on an explicit false', () => {
    const { unmount } = renderHeader({ retrievable: false, status: 'active' });
    expect(screen.getByTestId('datalake-selected-lake-unsearchable')).toHaveTextContent('Not searched by chat');
    unmount();

    renderHeader({ retrievable: undefined });
    expect(screen.queryByTestId('datalake-selected-lake-unsearchable')).not.toBeInTheDocument();
  });

  it('lets the draft chip explain a labelled draft instead of an access warning', () => {
    renderHeader({ status: 'draft', retrievable: false });
    expect(screen.getByTestId('datalake-selected-draft-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-selected-lake-unsearchable')).not.toBeInTheDocument();
  });

  it('flags a draft lake as not grounding answers', () => {
    renderHeader({ status: 'draft' });
    expect(screen.getByTestId('datalake-selected-draft-chip')).toHaveTextContent('Draft - not grounding answers');
  });

  it('flags a user lake with no status as not grounding answers', () => {
    renderHeader({ status: undefined });
    expect(screen.getByTestId('datalake-selected-draft-chip')).toBeInTheDocument();
  });

  it('shows no draft chip for an active lake', () => {
    renderHeader({ status: 'active' });
    expect(screen.queryByTestId('datalake-selected-draft-chip')).not.toBeInTheDocument();
  });

  it('shows no draft chip for a built-in lake with no status', () => {
    renderHeader({ id: DATA_LAKES[0].id, status: undefined });
    expect(screen.queryByTestId('datalake-selected-draft-chip')).not.toBeInTheDocument();
  });
});
