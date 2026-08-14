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
});
