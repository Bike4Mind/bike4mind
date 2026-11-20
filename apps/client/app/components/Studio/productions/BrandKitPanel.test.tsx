import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type StudioCompositionResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import BrandKitPanel from './BrandKitPanel';

const h = vi.hoisted(() => ({ updateMutate: vi.fn() }));

vi.mock('@client/app/hooks/data/studioCompositions', () => ({
  compositionErrorMessage: () => 'failed',
  compositionErrorIssues: () => [],
  useStudioCompositions: () => ({ data: [] }),
  useUpdateStudioComposition: () => ({ mutateAsync: h.updateMutate }),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFileByIdFromServer: async (id: string) => ({
    id,
    fileName: 'can.png',
    mimeType: 'image/png',
    fileUrl: 'https://files.test/can.png',
  }),
}));
vi.mock('@client/app/components/Files/EmbeddedFileBrowser', () => ({ default: () => null }));

// Well past the 600 ms field autosave debounce, so a loaded CI shard does not time out.
const AUTOSAVE_WAIT_MS = 3000;
const PHOTO = 'a'.repeat(24);
const LOOK = 'b'.repeat(24);

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const composition = (productFileIds: string[]): StudioCompositionResponse =>
  ({
    id: 'c'.repeat(24),
    title: 'Ad',
    template: 'ad_campaign',
    brief: {},
    brandKit: { colors: [], productFileIds },
    shots: [],
    timeline: defaultStudioTimeline('ad_campaign'),
  }) as unknown as StudioCompositionResponse;

describe('BrandKitPanel product look', () => {
  beforeEach(() => {
    h.updateMutate.mockReset().mockResolvedValue({});
  });

  it('marks the first product image as the look and saves another one to the front when picked', async () => {
    render(<BrandKitPanel composition={composition([PHOTO, LOOK])} />, { wrapper: Wrapper });

    expect(screen.getByTestId('production-brand-kit-product-look-badge')).toBeTruthy();
    expect(screen.getByTestId('production-brand-kit-product-look-hint')).toBeTruthy();
    expect(screen.queryByTestId(`production-brand-kit-product-${PHOTO}-select-btn`)).toBeNull();

    fireEvent.click(screen.getByTestId(`production-brand-kit-product-${LOOK}-select-btn`));

    await waitFor(
      () =>
        expect(h.updateMutate).toHaveBeenCalledWith({
          brandKit: expect.objectContaining({ productFileIds: [LOOK, PHOTO] }),
        }),
      { timeout: AUTOSAVE_WAIT_MS }
    );
  });

  it('promotes the next image to the look when the look is removed', async () => {
    render(<BrandKitPanel composition={composition([PHOTO, LOOK])} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId(`production-brand-kit-product-${PHOTO}-remove-btn`));

    await waitFor(
      () =>
        expect(h.updateMutate).toHaveBeenCalledWith({
          brandKit: expect.objectContaining({ productFileIds: [LOOK] }),
        }),
      { timeout: AUTOSAVE_WAIT_MS }
    );
  });

  it('shows no look marker for a single product image', () => {
    render(<BrandKitPanel composition={composition([PHOTO])} />, { wrapper: Wrapper });

    expect(screen.queryByTestId('production-brand-kit-product-look-badge')).toBeNull();
    expect(screen.queryByTestId('production-brand-kit-product-look-hint')).toBeNull();
  });
});
