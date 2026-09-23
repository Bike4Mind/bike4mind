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
}));

// "Start chat" pulls in SessionsContext/react-router/react-query transitively - irrelevant to this
// suite (build/rebuild + state chips + purge), so stub it to a no-op, same as DataLakeManagerPanel's suite.
vi.mock('@client/app/hooks/useStartChatWithLake', () => ({
  default: () => vi.fn(),
}));

const promoteMutate = vi.fn();
const demoteMutate = vi.fn();
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
  | {
      state: string;
      // The strict half of `state === 'building'`: a live extraction lease. `building` also covers a
      // PARKED continuation cursor, which nothing will move on its own - so only `running` may drive
      // "wait", and the two cases want opposite affordances (see the pair of tests below).
      running?: boolean;
      factCount: number;
      sourceDocumentCount: number;
      lastBuiltAt: string | null;
      memberCount: number;
    }
  | undefined;
const useGetLakeMemoryHealth = vi.fn<[], { data: LakeMemoryHealthMock }>(() => ({ data: undefined }));

// The rebuild door's two selectors share one mutation hook, so the panel's only record of WHICH
// door an owner opened is the argument it passes - which is what these capture.
const rechunkMutate = vi.fn();
type RebuildStatusMock =
  | {
      underChunkedCount: number;
      failedCount: number;
      staleEmbeddingSpaceCount: number | null;
      // Optional here on purpose: the cases that omit it are the ones that must stay silent.
      embeddingSpaceResolved?: boolean | null;
    }
  | undefined;
const useUnderChunkedCount = vi.fn<[], { data: RebuildStatusMock }>(() => ({ data: undefined }));

vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useArchiveDataLake: mutation,
    usePermanentDeleteDataLake: mutation,
    usePromoteDataLake: () => ({ mutate: promoteMutate, isPending: false }),
    useDemoteDataLake: () => ({ mutate: demoteMutate, isPending: false }),
    useUnderChunkedCount: (...args: unknown[]) => useUnderChunkedCount(...(args as [])),
    useRechunkDataLake: () => ({ mutate: rechunkMutate, isPending: false }),
    useLakeConvergencePlan: () => ({ data: undefined }),
    useConvergeDataLake: mutation,
    useGetDataLakeHealth: () => ({ data: undefined, isLoading: false }),
    // Read by DuplicateAdmissionsChip, which this panel renders unconditionally. A factory mock
    // replaces the whole module, so an unlisted export is `undefined` and every render here throws.
    // Undefined data leaves the chip with no open groups, so it renders null and stays out of the way.
    useGetLakeMembershipDuplicates: () => ({ data: undefined, isLoading: false }),
    // Same for LakeFindingsChip: it renders a neutral chip either way, so no findings just means
    // no open-count badge.
    useDataLakeFindings: () => ({ data: undefined, isLoading: false, error: null, isForbidden: false }),
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
  canManageMemory: true,
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
  useUnderChunkedCount.mockReset();
  useUnderChunkedCount.mockReturnValue({ data: undefined });
  rechunkMutate.mockClear();
  promoteMutate.mockClear();
  demoteMutate.mockClear();
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

  it('hides the build button and shows the "Building..." chip while a run actually holds the lease', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: {
        state: 'building',
        running: true,
        factCount: 0,
        sourceDocumentCount: 0,
        lastBuiltAt: null,
        memberCount: 0,
      },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-build-memory-btn-lake-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-memory-building-chip-lake-1')).toHaveTextContent('Building memory');
  });

  it('offers a build again for a run that stopped part-way, instead of "Building..." forever', () => {
    // `building` with NO live lease means a continuation cursor was parked and its chain is gone -
    // the platform flag went off mid-chain, the lake opted out, or the slice ceiling was hit. Nothing
    // will move that on its own, so showing "Building..." is a dead end the manager cannot leave.
    // This is the pairing the `running` split exists for, and it is why the chip may not read
    // `state === 'building'`.
    useGetLakeMemoryHealth.mockReturnValue({
      data: {
        state: 'building',
        running: false,
        factCount: 0,
        sourceDocumentCount: 0,
        lastBuiltAt: null,
        memberCount: 0,
      },
    });
    renderPanel();

    expect(screen.queryByTestId('datalake-memory-building-chip-lake-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-build-memory-btn-lake-1')).toHaveTextContent('Build memory');
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

  /**
   * The erase door is narrower than the panel that hosts it. `canManage` admits a curator and an
   * org-admin who can edit the lake's settings; a crypto-shred is irreversible and destroys facts
   * derived from other people's documents, so the API restricts it to the effective owner (or a
   * superuser). Rendering the button off `canManage` offered it to callers the API answers 403 to.
   */
  it('is absent for a manager who may configure the lake but not shred its memory', () => {
    useGetLakeMemoryHealth.mockReturnValue({
      data: { state: 'current', factCount: 8, sourceDocumentCount: 2, lastBuiltAt: null, memberCount: 4 },
    });
    renderPanel({ ...baseLake, canManageMemory: false });

    // The rest of the panel is unaffected: they still see the state and, when stale, the build door.
    expect(screen.getByTestId('datalake-memory-state-chip-lake-1')).toBeInTheDocument();
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

/**
 * The re-embed door. This is the one lake defect with no symptom an owner can see: retrieval
 * withholds a file embedded in a previous space wholesale rather than ranking it badly, so search
 * looks healthy and simply omits part of the corpus. The affordance below is the only thing that
 * tells anyone it happened - which is why its visibility rule is tested rather than eyeballed.
 */
describe('LakeInfoPanel - re-embed for search', () => {
  const REEMBED = 'datalake-reembed-space-btn-lake-1';

  it('offers the door with its count, and names the stale-space selector when clicked', async () => {
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 0, failedCount: 0, staleEmbeddingSpaceCount: 4 },
    });
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByTestId(REEMBED)).toHaveTextContent('Re-embed for search (4)');

    await user.click(screen.getByTestId(REEMBED));
    // The selector IS the whole difference between this door and Rebuild passages - they share the
    // route, the reset and the mutation hook, so an omitted `select` silently runs the wrong wave.
    expect(rechunkMutate).toHaveBeenCalledWith({ select: 'stale-embedding-space' });
  });

  it('stays hidden when every member is already in the current space', () => {
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 2, failedCount: 1, staleEmbeddingSpaceCount: 0 },
    });
    renderPanel();
    expect(screen.queryByTestId(REEMBED)).not.toBeInTheDocument();
  });

  it('stays hidden when the server could not resolve an embedding space', () => {
    // null is not a backlog. It covers a deployment with no usable embedding model AND a rolling
    // deploy against a server predating the field, and offering a re-embed in either case would
    // point owners at a wave with no space to land in.
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 0, failedCount: 0, staleEmbeddingSpaceCount: null },
    });
    renderPanel();
    expect(screen.queryByTestId(REEMBED)).not.toBeInTheDocument();
  });

  it('stays hidden before the status has loaded', () => {
    renderPanel();
    expect(screen.queryByTestId(REEMBED)).not.toBeInTheDocument();
  });

  it('stays hidden for a member who cannot rebuild the lake', () => {
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 0, failedCount: 0, staleEmbeddingSpaceCount: 4 },
    });
    renderPanel({ ...baseLake, canRebuild: false });
    expect(screen.queryByTestId(REEMBED)).not.toBeInTheDocument();
  });
});

describe('LakeInfoPanel - unresolvable embedding space', () => {
  const CHIP = 'datalake-embedding-space-unknown-chip-lake-1';

  it('says so when the server reports it could not resolve a space', () => {
    // The only place an owner can learn this. The re-embed button is hidden by the same null count,
    // and the route's 409 naming the remedy is reachable from nowhere else.
    useUnderChunkedCount.mockReturnValue({
      data: {
        underChunkedCount: 0,
        failedCount: 0,
        staleEmbeddingSpaceCount: null,
        embeddingSpaceResolved: false,
      },
    });
    renderPanel();
    expect(screen.getByTestId(CHIP)).toBeInTheDocument();
  });

  it('stays quiet when the server did not answer at all - that is a deploy skew, not a diagnosis', () => {
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 0, failedCount: 0, staleEmbeddingSpaceCount: null },
    });
    renderPanel();
    expect(screen.queryByTestId(CHIP)).not.toBeInTheDocument();
  });

  it('stays quiet on a healthy lake', () => {
    useUnderChunkedCount.mockReturnValue({
      data: { underChunkedCount: 0, failedCount: 0, staleEmbeddingSpaceCount: 0, embeddingSpaceResolved: true },
    });
    renderPanel();
    expect(screen.queryByTestId(CHIP)).not.toBeInTheDocument();
  });

  it('stays quiet for a member who cannot rebuild the lake', () => {
    useUnderChunkedCount.mockReturnValue({
      data: {
        underChunkedCount: 0,
        failedCount: 0,
        staleEmbeddingSpaceCount: null,
        embeddingSpaceResolved: false,
      },
    });
    renderPanel({ ...baseLake, canRebuild: false });
    expect(screen.queryByTestId(CHIP)).not.toBeInTheDocument();
  });
});

describe('LakeInfoPanel - publish/draft', () => {
  it('offers Publish for a draft lake, and calls the promote mutation on click', async () => {
    const user = userEvent.setup();
    renderPanel({ ...baseLake, status: 'draft' } as ManagerLake);

    expect(screen.queryByTestId('datalake-demote-btn-lake-1')).not.toBeInTheDocument();
    const btn = screen.getByTestId('datalake-promote-btn-lake-1');
    await user.click(btn);
    expect(promoteMutate).toHaveBeenCalledWith('lake-1');
  });

  it('offers Move to draft for an active lake, and calls the demote mutation on click', async () => {
    const user = userEvent.setup();
    renderPanel({ ...baseLake, status: 'active' } as ManagerLake);

    expect(screen.queryByTestId('datalake-promote-btn-lake-1')).not.toBeInTheDocument();
    const btn = screen.getByTestId('datalake-demote-btn-lake-1');
    await user.click(btn);
    expect(demoteMutate).toHaveBeenCalledWith('lake-1');
  });

  // A lake written before `status` existed carries none, and retrieval's `status: 'active'`
  // pre-filter excludes it exactly like a draft. promoteDataLake accepts it (activateIfDraft
  // matches `$in: ['draft', null]`), so the panel has to offer the door or that lake can never
  // be published from the UI at all.
  it('offers Publish for a legacy lake that carries no status', async () => {
    const user = userEvent.setup();
    renderPanel({ ...baseLake, status: undefined } as ManagerLake);

    expect(screen.queryByTestId('datalake-demote-btn-lake-1')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('datalake-promote-btn-lake-1'));
    expect(promoteMutate).toHaveBeenCalledWith('lake-1');
  });

  it('offers neither button for a lake in a lifecycle state other than draft/active', () => {
    renderPanel({ ...baseLake, status: 'archived' } as ManagerLake);

    expect(screen.queryByTestId('datalake-promote-btn-lake-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-demote-btn-lake-1')).not.toBeInTheDocument();
  });
});
