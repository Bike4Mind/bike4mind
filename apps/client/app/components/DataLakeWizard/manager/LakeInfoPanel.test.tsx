import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { LakeInfoPanel } from './LakeInfoPanel';
import type { ManagerLake } from './shared';

// LakeInfoPanel's Drive chip reaches this hook directly - stub it so the chip renders nothing
// rather than needing a QueryClientProvider.
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: null, isError: false, isLoading: false }),
  DRIVE_STATUS_BADGE: {
    connected: { label: 'Connected', color: 'success' },
    needs_reconnect: { label: 'Needs reconnect', color: 'warning' },
    credential_error: { label: 'Credential error', color: 'danger' },
  },
}));

// "Start chat" pulls in SessionsContext/react-router/react-query transitively - irrelevant to this
// suite (build/rebuild + state chips + purge), so stub it to a no-op, same as DataLakeManagerPanel's suite.
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({
  default: () => vi.fn(),
}));

const buildMutate = vi.fn();
const purgeMutate = vi.fn((_?: undefined, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
const buildPending = vi.fn(() => false);
const purgePending = vi.fn(() => false);
// Capture the lake id each mutation hook was constructed with, since mutate() itself takes no
// id argument - the id is closed over by the hook, not passed at call time (see useBuildLakeMemory
// / usePurgeLakeMemory in dataLakes.ts).
const buildHookSpy = vi.fn();
const purgeHookSpy = vi.fn();

type LakeMemoryHealthMock =
  | { state: string; factCount: number; sourceDocumentCount: number; lastBuiltAt: string | null; memberCount: number }
  | undefined;
const useGetLakeMemoryHealth = vi.fn<[], { data: LakeMemoryHealthMock }>(() => ({ data: undefined }));

vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useArchiveDataLake: mutation,
    usePermanentDeleteDataLake: mutation,
    useUnderChunkedCount: () => ({ data: undefined }),
    useRechunkDataLake: mutation,
    useLakeConvergencePlan: () => ({ data: undefined }),
    useConvergeDataLake: mutation,
    useGetDataLakeHealth: () => ({ data: undefined, isLoading: false }),
    useGetLakeMemoryHealth: (...args: unknown[]) => useGetLakeMemoryHealth(...(args as [])),
    useBuildLakeMemory: (id: string | null) => {
      buildHookSpy(id);
      return { mutate: buildMutate, isPending: buildPending() };
    },
    usePurgeLakeMemory: (id: string | null) => {
      purgeHookSpy(id);
      return { mutate: purgeMutate, isPending: purgePending() };
    },
  };
});

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseLake: ManagerLake = {
  id: 'lake-1',
  name: 'Test Lake',
  slug: 'test-lake',
  description: 'desc',
  fileTagPrefix: 'lk',
  requiredUserTag: '',
  organizationId: '',
  isPublic: false,
  canManage: true,
  canRebuild: true,
  isOwn: true,
} as ManagerLake;

const noopProps = {
  fileCount: undefined,
  armCounts: undefined,
  taxonomyBatch: undefined,
  onOpenSettings: vi.fn(),
  onOpenAccess: vi.fn(),
  onOpenFallbackSettings: vi.fn(),
  onReviewTaxonomy: vi.fn(),
  onArchived: vi.fn(),
  onDeleted: vi.fn(),
};

const renderPanel = (lake: ManagerLake = baseLake) =>
  render(
    <Wrapper>
      <LakeInfoPanel lake={lake} {...noopProps} />
    </Wrapper>
  );

beforeEach(() => {
  useGetLakeMemoryHealth.mockReset();
  useGetLakeMemoryHealth.mockReturnValue({ data: undefined });
  buildMutate.mockClear();
  purgeMutate.mockClear();
  buildPending.mockReset();
  buildPending.mockReturnValue(false);
  purgePending.mockReset();
  purgePending.mockReturnValue(false);
  buildHookSpy.mockClear();
  purgeHookSpy.mockClear();
});

describe('LakeInfoPanel - lake memory build/rebuild', () => {
  it('shows "Build memory" and calls the build mutation for a never-built lake', async () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'never-built', factCount: 0, sourceDocumentCount: 0, lastBuiltAt: null, memberCount: 0 },
    });
    const user = userEvent.setup();
    renderPanel();

    const btn = screen.getByTestId('datalake-build-memory-btn-lake-1');
    expect(btn).toHaveTextContent('Build memory');
    await user.click(btn);
    expect(buildMutate).toHaveBeenCalled();
    // The build mutation itself is scoped to this lake at hook-construction time, not passed
    // per-call (see useBuildLakeMemory(dataLakeId) in dataLakes.ts).
    expect(buildHookSpy).toHaveBeenCalledWith('lake-1');
  });

  it('shows "Rebuild memory" wording for a stale (already-built) lake', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: {
        state: 'stale',
        factCount: 12,
        sourceDocumentCount: 3,
        lastBuiltAt: '2026-01-01T00:00:00.000Z',
        memberCount: 5,
      },
    });
    renderPanel();

    expect(screen.getByTestId('datalake-build-memory-btn-lake-1')).toHaveTextContent('Rebuild memory');
  });

  it('hides the build button and shows the "Building..." chip while building', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'building', factCount: 0, sourceDocumentCount: 0, lastBuiltAt: null, memberCount: 0 },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-memory-building-chip-lake-1')).toHaveTextContent('Building memory');
  });

  it('offers no build button for a "current" (up to date) lake, only the state chip', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: {
        state: 'current',
        factCount: 8,
        sourceDocumentCount: 2,
        lastBuiltAt: '2026-01-01T00:00:00.000Z',
        memberCount: 4,
      },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-memory-state-chip-lake-1')).toHaveTextContent('8 fact(s)');
  });
});

describe('LakeInfoPanel - lake memory state visibility', () => {
  it('shows the platform-off chip alongside the state chip, with no build button, when the platform gate is off', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'platform-off', factCount: 0, sourceDocumentCount: 0, lastBuiltAt: null, memberCount: 0 },
    });
    renderPanel();

    expect(screen.getByTestId('datalake-memory-platform-off-chip-lake-1')).toHaveTextContent('off platform-wide');
    // The state chip is only hidden for 'lake-off' - 'platform-off' still shows it alongside the
    // dedicated platform-off chip.
    expect(screen.getByTestId('datalake-memory-state-chip-lake-1')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
  });

  it('does not show the platform-off chip when the platform gate is on', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'current', factCount: 8, sourceDocumentCount: 2, lastBuiltAt: null, memberCount: 4 },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-memory-platform-off-chip-lake-1')).not.toBeInTheDocument();
  });

  it('hides the state chip entirely when the lake itself has memory off ("lake-off")', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'lake-off', factCount: 0, sourceDocumentCount: 0, lastBuiltAt: null, memberCount: 0 },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-memory-state-chip-lake-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-memory-platform-off-chip-lake-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
  });

  it('renders no lake-memory affordances at all for a caller who cannot manage the lake', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'current', factCount: 8, sourceDocumentCount: 2, lastBuiltAt: null, memberCount: 4 },
    });
    renderPanel({ ...baseLake, canManage: false });

    expect(screen.queryByTestId('datalake-memory-state-chip-lake-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-purge-memory-btn-lake-1')).not.toBeInTheDocument();
  });
});

describe('LakeInfoPanel - erase memory (purge)', () => {
  it('is absent for a lake with no existing memory profile (factCount 0)', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'never-built', factCount: 0, sourceDocumentCount: 0, lastBuiltAt: null, memberCount: 0 },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-purge-memory-btn-lake-1')).not.toBeInTheDocument();
  });

  it('opens a confirm dialog on click and only purges after confirming, not on the initial click', async () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'current', factCount: 8, sourceDocumentCount: 2, lastBuiltAt: null, memberCount: 4 },
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-purge-memory-btn-lake-1'));
    expect(screen.getByTestId('datalake-purge-memory-confirm')).toBeInTheDocument();
    // Not sent yet - only opened the dialog.
    expect(purgeMutate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('datalake-purge-memory-confirm-btn'));
    expect(purgeMutate).toHaveBeenCalled();
    // Scoped to this lake at hook-construction time (see usePurgeLakeMemory(dataLakeId)).
    expect(purgeHookSpy).toHaveBeenCalledWith('lake-1');
  });

  it('can be dismissed (Escape) without calling the purge mutation', async () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'current', factCount: 8, sourceDocumentCount: 2, lastBuiltAt: null, memberCount: 4 },
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('datalake-purge-memory-btn-lake-1'));
    expect(screen.getByTestId('datalake-purge-memory-confirm')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('datalake-purge-memory-confirm')).not.toBeInTheDocument();
    expect(purgeMutate).not.toHaveBeenCalled();
  });
});
