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

// LakeSourceConnectActions itself stays real: it gates GitHub on the lake's organizationId, so a
// header that forwards a trimmed lake silently drops the GitHub control. Only its data and leaves are stubbed.
const h = vi.hoisted(() => ({ gitHubFlag: { current: true } }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub' && h.gitHubFlag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ useLakeDriveConnection: () => ({ data: null }) }));
vi.mock('@client/app/hooks/data/githubLake', () => ({ useLakeGitHubConnection: () => ({ data: null }) }));
vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({
  default: () => <div data-testid="drive-connect-action" />,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({
  default: () => <div data-testid="github-connect-action" />,
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
    isCreator: true,
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
  h.gitHubFlag.current = true;
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

  it('offers both Drive and GitHub on an org lake with GitHub enabled', () => {
    renderHeader();
    expect(screen.getByTestId('drive-connect-action')).toBeInTheDocument();
    expect(screen.getByTestId('github-connect-action')).toBeInTheDocument();
  });

  it('offers the Drive control on a personal lake the caller created', () => {
    // A personal lake's connection syncs on its creator's own Google grant (authorizeLakeDriveAccess),
    // so creation - not org management, and not effective ownership - is the gate here. GitHub stays
    // org-only.
    renderHeader({ organizationId: undefined, isCreator: true });
    expect(screen.getByTestId('datalake-selected-lake-source')).toBeInTheDocument();
    expect(screen.getByTestId('drive-connect-action')).toBeInTheDocument();
    expect(screen.queryByTestId('github-connect-action')).not.toBeInTheDocument();
  });

  it('withholds the Drive control on a personal lake the caller owns but did not create', () => {
    // After an ownership transfer, isOwn is true but isCreator is false - membership and the
    // ingest's admin-actor writes are anchored to createdByUserId, so the control must follow
    // isCreator, not isOwn.
    renderHeader({ organizationId: undefined, isOwn: true, isCreator: false });
    expect(screen.queryByTestId('datalake-selected-lake-source')).not.toBeInTheDocument();
  });

  it('offers the Drive control on a personal lake the caller created but no longer owns', () => {
    renderHeader({ organizationId: undefined, isOwn: false, isCreator: true });
    expect(screen.getByTestId('datalake-selected-lake-source')).toBeInTheDocument();
  });

  it.each([
    ['a personal lake the caller did not create', { organizationId: undefined, isCreator: false }],
    ['an org lake the caller cannot manage', { canManage: false }],
  ])('withholds the Drive control on %s', (_label, over) => {
    // Server-side the status route 404s for anyone but an org lake's owner/manager or a personal
    // lake's own creator, so a control here could only ever fail.
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
