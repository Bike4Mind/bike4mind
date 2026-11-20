import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type StudioRenderJob, type StudioTimeline } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  jobs: [] as unknown[],
  mutate: vi.fn(),
  mutation: { isPending: false, isError: false, error: null as unknown },
  getFile: vi.fn(),
}));

vi.mock('@client/app/hooks/data/studioRenders', () => ({
  isRenderInFlight: (job: { state: string }) => ['pending', 'running', 'storing'].includes(job.state),
  renderErrorMessage: () => 'Not enough credits for this export.',
  useStudioRenders: () => ({ data: h.jobs }),
  useCreateStudioRenders: () => ({ mutate: h.mutate, ...h.mutation }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => undefined }));
vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFileByIdFromServer: h.getFile,
}));

import { ExportPanel } from './ExportPanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const withClip = (): StudioTimeline => {
  const timeline = defaultStudioTimeline('blank');
  return {
    ...timeline,
    tracks: [
      {
        id: 't1',
        kind: 'video',
        enabled: true,
        clips: [{ id: 'c1', fileId: 'a'.repeat(24), startMs: 0, durationMs: 1000 }],
      },
    ],
  } as unknown as StudioTimeline;
};

const job = (overrides: Partial<StudioRenderJob>): StudioRenderJob => ({
  id: 'j1',
  groupId: 'g1',
  compositionId: 'comp',
  state: 'pending',
  progress: null,
  output: { id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080 },
  heldCredits: 10,
  settledCredits: null,
  error: null,
  file: null,
  createdAt: '2026-11-17T00:00:00.000Z',
  ...overrides,
});

const renderPanel = (props: { timeline?: StudioTimeline; canExport?: boolean } = {}) => {
  const timeline = props.timeline ?? withClip();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <ExportPanel compositionId="comp" timeline={timeline} canExport={props.canExport ?? true} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return timeline;
};

const open = () => fireEvent.click(screen.getByTestId('production-export-open-btn'));

beforeEach(() => {
  h.jobs = [];
  h.mutate.mockReset();
  h.mutation = { isPending: false, isError: false, error: null };
  h.getFile.mockReset();
  h.getFile.mockResolvedValue({ fileName: 'out.mp4', presignedUrl: 'https://files.test/out.mp4' });
});

describe('ExportPanel', () => {
  it('lists a checkbox per timeline output', () => {
    const timeline = renderPanel();
    open();
    for (const output of timeline.outputs) {
      expect(screen.getByTestId(`production-export-output-checkbox-${output.id}`)).toBeInTheDocument();
    }
  });

  it('disables Export until the production is saved', () => {
    renderPanel({ canExport: false });
    expect(screen.getByTestId('production-export-open-btn')).toBeDisabled();
  });

  it('disables Export while the timeline has no clips', () => {
    renderPanel({ timeline: defaultStudioTimeline('blank') });
    expect(screen.getByTestId('production-export-open-btn')).toBeDisabled();
  });

  it('disables Export while every track with clips is disabled', () => {
    const timeline = withClip();
    renderPanel({ timeline: { ...timeline, tracks: timeline.tracks.map(track => ({ ...track, enabled: false })) } });
    expect(screen.getByTestId('production-export-open-btn')).toBeDisabled();
  });

  it('submits the selected output ids', () => {
    const timeline = renderPanel();
    open();
    const target = timeline.outputs[0];
    expect(screen.getByTestId('production-export-submit-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId(`production-export-output-checkbox-${target.id}`));
    fireEvent.click(screen.getByTestId('production-export-submit-btn'));
    expect(h.mutate).toHaveBeenCalledWith([target.id], expect.anything());
  });

  it('shows progress for a running job', () => {
    h.jobs = [job({ state: 'running', progress: 0.4 })];
    renderPanel();
    open();
    expect(screen.getByTestId('production-export-job-row-j1')).toBeInTheDocument();
    expect(screen.getByTestId('production-export-job-progress-j1')).toBeInTheDocument();
  });

  it('links the download of a succeeded job', async () => {
    h.jobs = [job({ state: 'succeeded', file: { fileId: 'b'.repeat(24), bytes: 10, durationSeconds: 1 } })];
    renderPanel();
    open();
    const link = await screen.findByTestId('production-export-download-link-j1');
    expect(link).toHaveAttribute('href', 'https://files.test/out.mp4');
  });

  it('keeps fetching the file until it serves a download URL', async () => {
    h.getFile.mockResolvedValueOnce({ fileName: 'out.mp4', presignedUrl: null, fileUrl: null });
    h.jobs = [job({ state: 'succeeded', file: { fileId: 'b'.repeat(24), bytes: 10, durationSeconds: 1 } })];
    renderPanel();
    open();
    const link = await screen.findByTestId('production-export-download-link-j1', {}, { timeout: 5000 });
    expect(link).toHaveAttribute('href', 'https://files.test/out.mp4');
    expect(h.getFile).toHaveBeenCalledTimes(2);
  });

  it('shows the server error message once, without appending a second refund note', () => {
    const message = 'The export failed. Your credits were refunded.';
    h.jobs = [job({ state: 'failed', error: { code: 'provider_error', message } })];
    renderPanel();
    open();
    expect(screen.getByTestId('production-export-job-error-j1')).toHaveTextContent(new RegExp(`^${message}$`));
  });

  it('falls back to a refund note when a failed job carries no message', () => {
    h.jobs = [job({ state: 'failed', error: null })];
    renderPanel();
    open();
    expect(screen.getByTestId('production-export-job-error-j1')).toHaveTextContent('refunded');
  });

  it('shows the refusal message when the export is refused', () => {
    h.mutation = { isPending: false, isError: true, error: new Error('refused') };
    renderPanel();
    open();
    expect(screen.getByTestId('production-export-error')).toHaveTextContent('Not enough credits for this export.');
  });
});
