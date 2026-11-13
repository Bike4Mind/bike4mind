import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import { getThemeConfig } from '@client/app/utils/themes';

type FileState = { data?: { fileUrl?: string; moderationStatus?: string }; isError?: boolean };

const h = vi.hoisted(() => ({
  file: {} as FileState,
  useGetFabFile: vi.fn(),
}));

vi.mock('@client/app/hooks/data/fabFileQueries', () => ({
  useGetFabFile: (...args: unknown[]) => {
    h.useGetFabFile(...args);
    return h.file;
  },
  isFabFileScanInFlight: (f: { moderationStatus?: string }) =>
    f.moderationStatus === 'pending' || f.moderationStatus === 'scanning',
}));

vi.mock('@client/app/components/Studio/trail/StudioTrailDialog', () => ({ default: () => null }));

import ImageJobCard, { IMAGE_SCAN_WAIT_MS } from './ImageJobCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const FILE_ID = 'f'.repeat(24);

const savedJob: StudioImageJob = {
  id: 'done',
  groupId: 'group',
  state: 'succeeded',
  request: { model: 'gpt-image-1.5', mode: 'generate', prompt: 'a red fox' } as StudioImageJob['request'],
  error: null,
  output: { fileId: FILE_ID, contentType: 'image/png', bytes: 1 },
  createdAt: '2026-11-01T00:00:00.000Z',
};

const renderCard = () => render(<ImageJobCard job={savedJob} />, { wrapper: TestWrapper });

beforeEach(() => {
  h.file = {};
  h.useGetFabFile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageJobCard preview', () => {
  it('polls while the moderation scan runs and shows the image once it is clean', () => {
    h.file = { data: { moderationStatus: 'scanning' } };
    const { rerender } = renderCard();
    expect(screen.getByTestId('image-job-image-loading')).toBeInTheDocument();
    expect(h.useGetFabFile).toHaveBeenLastCalledWith(FILE_ID, { pollWhileScanning: true });

    h.file = { data: { moderationStatus: 'clean', fileUrl: 'https://files.example/fox.png' } };
    rerender(<ImageJobCard job={savedJob} />);
    expect(screen.getByTestId('image-job-image')).toHaveAttribute('src', 'https://files.example/fox.png');
  });

  it('settles on a blocked image instead of spinning', () => {
    h.file = { data: { moderationStatus: 'blocked' } };
    renderCard();
    expect(screen.getByTestId('image-job-image-blocked')).toHaveTextContent('blocked by content moderation');
    expect(screen.queryByTestId('image-job-image-loading')).not.toBeInTheDocument();
  });

  it('stops polling and says so when the scan outlasts the wait', () => {
    vi.useFakeTimers();
    h.file = { data: { moderationStatus: 'pending' } };
    renderCard();
    expect(screen.getByTestId('image-job-image-loading')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(IMAGE_SCAN_WAIT_MS);
    });
    expect(screen.getByTestId('image-job-image-unavailable')).toHaveTextContent('could not be loaded');
    expect(h.useGetFabFile).toHaveBeenLastCalledWith(FILE_ID, { pollWhileScanning: false });
  });

  it('says the image is unavailable when the file read fails', () => {
    h.file = { isError: true };
    renderCard();
    expect(screen.getByTestId('image-job-image-unavailable')).toBeInTheDocument();
  });
});
