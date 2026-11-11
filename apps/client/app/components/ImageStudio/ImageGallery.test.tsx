import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  jobs: [] as unknown[],
  files: {} as Record<string, { fileUrl?: string } | undefined>,
}));

vi.mock('@client/app/hooks/data/studioImageJobs', () => ({
  useStudioImageJobs: () => ({
    data: { pages: [{ data: h.jobs, next_cursor: null }] },
    isPending: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock('@client/app/hooks/data/fabFileQueries', () => ({
  useGetFabFile: (id: string) => ({ data: h.files[id] }),
}));

import ImageGallery from './ImageGallery';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const job = (overrides: Partial<StudioImageJob>): StudioImageJob => ({
  id: 'job',
  groupId: 'group',
  state: 'pending',
  request: { model: 'gpt-image-1.5', mode: 'generate', prompt: 'a red fox' } as StudioImageJob['request'],
  error: null,
  output: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  h.jobs = [];
  h.files = {};
});

describe('ImageGallery', () => {
  it('says where images will appear before there are any', () => {
    render(<ImageGallery />, { wrapper: TestWrapper });
    expect(screen.getByTestId('image-gallery-empty')).toHaveTextContent('Images you generate will appear here.');
  });

  it('shows a live card, a finished image and a failure', () => {
    h.jobs = [
      job({ id: 'live', state: 'running' }),
      job({
        id: 'done',
        state: 'succeeded',
        output: { fileId: 'a'.repeat(24), contentType: 'image/png', bytes: 10 },
      }),
      job({ id: 'failed', state: 'failed', error: { code: 'content_blocked', message: 'Declined.' } }),
    ];
    h.files = { ['a'.repeat(24)]: { fileUrl: 'https://files.example/fox.png' } };
    render(<ImageGallery />, { wrapper: TestWrapper });

    expect(screen.getByTestId('image-job-live')).toHaveTextContent('Generating');
    expect(screen.getByTestId('image-job-image')).toHaveAttribute('src', 'https://files.example/fox.png');
    expect(screen.getByTestId('image-job-image')).toHaveAttribute('alt', 'a red fox');
    expect(screen.getByTestId('image-job-error')).toHaveTextContent('Declined.');
    expect(screen.getByTestId('image-job-card-done')).toHaveAttribute('data-state', 'succeeded');
  });

  it('waits on the signed file before showing the image', () => {
    h.jobs = [
      job({ id: 'done', state: 'succeeded', output: { fileId: 'b'.repeat(24), contentType: 'image/png', bytes: 1 } }),
    ];
    render(<ImageGallery />, { wrapper: TestWrapper });
    expect(screen.getByTestId('image-job-image-loading')).toBeInTheDocument();
  });

  it('settles a finished image kept outside Files instead of waiting on it', () => {
    h.jobs = [job({ id: 'done', state: 'succeeded', output: { fileId: null, contentType: 'image/png', bytes: 1 } })];
    render(<ImageGallery />, { wrapper: TestWrapper });
    expect(screen.getByTestId('image-job-unviewable')).toHaveTextContent('could not be added to your Files');
    expect(screen.queryByTestId('image-job-image-loading')).not.toBeInTheDocument();
  });
});
