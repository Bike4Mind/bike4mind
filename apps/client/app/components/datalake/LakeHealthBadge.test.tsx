import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const useGetDataLakeHealth = vi.fn();
vi.mock('@client/app/hooks/data/dataLakes', () => ({ useGetDataLakeHealth: () => useGetDataLakeHealth() }));

import LakeHealthBadge, { deriveLakeHealthBadge } from './LakeHealthBadge';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const predicates = (over?: Partial<Record<string, unknown>>) => ({
  chunkWithinPolicy: { pass: 1, fail: 0, unknown: 0 },
  chunkCountConsistent: { pass: 1, fail: 0, unknown: 0 },
  fullyVectorized: { pass: 1, fail: 0, unknown: 0 },
  serveCapMeetsPolicy: 'pass' as const,
  ...over,
});

describe('deriveLakeHealthBadge', () => {
  it('is unknown when nothing is measured (share null), never a false low score', () => {
    expect(deriveLakeHealthBadge({ reachableShare: null, predicates: predicates() })).toBe('unknown');
  });

  it('is healthy only when reachability is high AND no predicate fails', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 1, predicates: predicates() })).toBe('healthy');
    expect(deriveLakeHealthBadge({ reachableShare: 0.97, predicates: predicates() })).toBe('healthy');
  });

  it('is degraded on a predicate failure even at high reachability', () => {
    expect(
      deriveLakeHealthBadge({
        reachableShare: 0.99,
        predicates: predicates({ fullyVectorized: { pass: 4, fail: 1, unknown: 0 } }),
      })
    ).toBe('degraded');
  });

  it('is degraded in the middle reachability band', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 0.8, predicates: predicates() })).toBe('degraded');
  });

  it('is unhealthy below half reachable', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 0.245, predicates: predicates() })).toBe('unhealthy');
  });

  it('treats a serve-cap-below-policy (P4) defect as unhealthy regardless of reachability', () => {
    expect(deriveLakeHealthBadge({ reachableShare: 1, predicates: predicates({ serveCapMeetsPolicy: 'fail' }) })).toBe(
      'unhealthy'
    );
  });

  it('is unhealthy for a P4 defect even when NOTHING is measured yet (not "unknown")', () => {
    // P4 is a policy fact, not a measurement; it must be graded before the null-share early return, or
    // an org with an oversized DefaultChunkSize hides the defect behind a neutral chip on every lake.
    expect(
      deriveLakeHealthBadge({ reachableShare: null, predicates: predicates({ serveCapMeetsPolicy: 'fail' }) })
    ).toBe('unhealthy');
  });

  it('is degraded (not "unknown") when a per-file predicate fails but nothing is measured yet', () => {
    // e.g. a still-indexing file already carries an oversized chunk: the share is unknown, but a known
    // defect must not hide behind the neutral "not measured" chip.
    expect(
      deriveLakeHealthBadge({
        reachableShare: null,
        predicates: predicates({ chunkWithinPolicy: { pass: 0, fail: 1, unknown: 0 } }),
      })
    ).toBe('degraded');
  });

  it('stays "unknown" only for a genuinely clean, unmeasured lake', () => {
    expect(deriveLakeHealthBadge({ reachableShare: null, predicates: predicates() })).toBe('unknown');
  });
});

const health = (over?: Record<string, unknown>) => ({
  policy: { chunkTokenTarget: 512, source: 'inherited', policyChars: 3072, serveCap: 3072, serveCapBelowPolicy: false },
  predicates: predicates(),
  reachableShare: 1,
  reachableChars: 100,
  measuredChunkedChars: 100,
  coverage: { measuredMembers: 1, membersWithChunks: 1 },
  affectedMembers: [],
  affectedMemberCount: 0,
  scanTruncated: false,
  ...over,
});

describe('LakeHealthBadge render', () => {
  it('renders nothing while loading or before data', () => {
    useGetDataLakeHealth.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a lake with no chunked members (empty lake)', () => {
    useGetDataLakeHealth.mockReturnValue({
      data: health({ coverage: { measuredMembers: 0, membersWithChunks: 0 }, reachableShare: null }),
      isLoading: false,
    });
    const { container } = render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('leads with the reachable-content headline for a degraded lake', () => {
    useGetDataLakeHealth.mockReturnValue({
      data: health({
        reachableShare: 0.25,
        predicates: predicates({ chunkWithinPolicy: { pass: 0, fail: 3, unknown: 0 } }),
        affectedMembers: [
          {
            fabFileId: 'f1',
            fileName: 'big.txt',
            chunkCount: 1,
            measured: true,
            status: {},
            failed: ['chunkWithinPolicy'],
            reachableChars: 3072,
            chunkedChars: 12000,
          },
        ],
        affectedMemberCount: 1,
      }),
      isLoading: false,
    });
    render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-health-badge-l1')).toHaveTextContent('Reachable 25%');
  });

  it('shows "not measured" (not 0%) for an unmeasured lake', () => {
    useGetDataLakeHealth.mockReturnValue({
      data: health({ reachableShare: null, coverage: { measuredMembers: 0, membersWithChunks: 4 } }),
      isLoading: false,
    });
    render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-health-badge-l1')).toHaveTextContent('not measured');
  });

  it('shows the serve-cap label (not "Reachable 0%") for an unmeasured P4-defect lake', () => {
    useGetDataLakeHealth.mockReturnValue({
      data: health({
        reachableShare: null,
        predicates: predicates({ serveCapMeetsPolicy: 'fail' }),
        coverage: { measuredMembers: 0, membersWithChunks: 3 },
      }),
      isLoading: false,
    });
    render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    const badge = screen.getByTestId('datalake-health-badge-l1');
    expect(badge).toHaveTextContent('Serve cap below policy');
    expect(badge).not.toHaveTextContent('Reachable 0%');
  });

  it('shows "needs attention" (not "not measured") for an unmeasured lake with a failing predicate', () => {
    useGetDataLakeHealth.mockReturnValue({
      data: health({
        reachableShare: null,
        predicates: predicates({ chunkWithinPolicy: { pass: 0, fail: 2, unknown: 0 } }),
        coverage: { measuredMembers: 0, membersWithChunks: 2 },
      }),
      isLoading: false,
    });
    render(
      <Wrapper>
        <LakeHealthBadge lakeId="l1" />
      </Wrapper>
    );
    const badge = screen.getByTestId('datalake-health-badge-l1');
    expect(badge).toHaveTextContent('needs attention');
    expect(badge).not.toHaveTextContent('not measured');
    expect(badge).not.toHaveTextContent('Reachable');
  });
});
