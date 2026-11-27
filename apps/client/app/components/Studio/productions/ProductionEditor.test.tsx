import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultStudioTimeline, type IFabFileDocument, type StudioCompositionResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const VIDEO_FILE_ID = 'f'.repeat(24);

const h = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  pickedFiles: [] as unknown[],
  blocker: {
    options: null as null | { shouldBlockFn: () => boolean; enableBeforeUnload: boolean },
    status: 'idle' as 'idle' | 'blocked',
    proceed: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useBlocker: (options: { shouldBlockFn: () => boolean; enableBeforeUnload: boolean }) => {
    h.blocker.options = options;
    return { status: h.blocker.status, proceed: h.blocker.proceed, reset: h.blocker.reset };
  },
}));

vi.mock('@client/app/hooks/data/studioCompositions', () => ({
  compositionErrorMessage: () => 'failed',
  compositionErrorIssues: () => [],
  studioCompositionKeys: { detail: (id: string) => ['studioCompositions', 'detail', id] },
  useStudioCompositions: () => ({ data: [] }),
  useCreateStudioComposition: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateStudioComposition: () => ({
    mutate: h.updateMutate,
    mutateAsync: h.updateMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFileByIdFromServer: async (id: string) => ({
    id,
    fileName: 'hero.mp4',
    mimeType: 'video/mp4',
    fileUrl: 'https://files.test/hero.mp4',
  }),
}));
vi.mock('./probeMediaDuration', () => ({ probeMediaDurationMs: async () => 6_000 }));
// The Library browser has its own tests; here it only has to open and hand back the picked files.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('@client/app/components/Files/EmbeddedFileBrowser', () => ({
  default: forwardRef(function PickerStub(
    {
      onAdd,
      lockedFilters,
      initialFilters,
    }: { onAdd: (files: unknown[]) => void; lockedFilters?: { type: string }; initialFilters?: { type: string } },
    ref
  ) {
    const [open, setOpen] = useState(false);
    useImperativeHandle(ref, () => ({ handleOpen: () => setOpen(true) }));
    if (!open) return null;
    return (
      <button
        type="button"
        data-testid="picker-stub-add"
        data-filter={lockedFilters?.type ?? initialFilters?.type}
        onClick={() => {
          setOpen(false);
          onAdd(h.pickedFiles);
        }}
      >
        Add
      </button>
    );
  }),
}));

import ProductionEditor from './ProductionEditor';
import { FIELD_AUTOSAVE_DELAY_MS } from './useFieldAutosave';
import { SAVE_DEBOUNCE_MS } from './useTimelineAutosave';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderEditor = (composition: StudioCompositionResponse) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
  return render(<ProductionEditor composition={composition} />, { wrapper: Wrapper });
};

const composition = (): StudioCompositionResponse => ({
  id: 'c'.repeat(24),
  title: 'Spring ad',
  template: 'ad_campaign',
  brief: {},
  brandKit: { colors: [], productFileIds: [], characters: [] },
  shots: [],
  timeline: defaultStudioTimeline('ad_campaign'),
  createdAt: new Date(),
  updatedAt: new Date(),
});

const clipsIn = (lane: string) => within(screen.getByTestId(`production-lane-${lane}`)).queryAllByRole('button');

beforeEach(() => {
  vi.clearAllMocks();
  h.pickedFiles = [];
  h.blocker.status = 'idle';
  h.blocker.options = null;
});

afterEach(() => {
  vi.useRealTimers();
});

const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('ProductionEditor', () => {
  it('draws an empty lane per track kind and previews the first output', () => {
    renderEditor(composition());
    for (const kind of ['video', 'voice', 'sfx', 'music', 'captions']) {
      expect(screen.getByTestId(`production-lane-${kind}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('production-preview-stage')).toHaveAttribute('data-aspect-ratio', '16:9');
    expect(screen.getByTestId('production-save-status')).toHaveAttribute('data-status', 'saved');
  });

  it('switches the preview between the 16:9, 9:16 and 1:1 outputs', () => {
    renderEditor(composition());
    for (const [testId, ratio] of [
      ['9x16', '9:16'],
      ['1x1', '1:1'],
      ['16x9', '16:9'],
    ]) {
      fireEvent.click(screen.getByTestId(`production-preview-size-${testId}`));
      expect(screen.getByTestId('production-preview-stage')).toHaveAttribute('data-aspect-ratio', ratio);
    }
  });

  it('adds a caption, edits its text in the inspector and shows it in the preview', () => {
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    expect(clipsIn('captions')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('production-inspector-text-input'), { target: { value: 'Buy now' } });
    expect(screen.getByTestId('production-preview')).toHaveTextContent('Buy now');
  });

  it('adds a Library video to the video track at its own length', async () => {
    h.pickedFiles = [
      { id: VIDEO_FILE_ID, fileName: 'hero.mp4', mimeType: 'video/mp4', fileUrl: 'https://files.test/hero.mp4' },
    ] as Partial<IFabFileDocument>[];
    renderEditor(composition());

    fireEvent.click(screen.getByTestId('production-add-video-btn'));
    expect(screen.getByTestId('picker-stub-add')).toHaveAttribute('data-filter', 'video');
    fireEvent.click(screen.getByTestId('picker-stub-add'));

    await waitFor(() => expect(clipsIn('video')).toHaveLength(1));
    expect(await screen.findByText('hero.mp4', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByTestId('production-inspector-duration-input')).toHaveValue(6);
  });

  it('filters the picker to audio for the audio tracks', () => {
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-add-music-btn'));
    expect(screen.getByTestId('picker-stub-add')).toHaveAttribute('data-filter', 'audio');
  });

  it('saves a valid edit after a pause', async () => {
    vi.useFakeTimers();
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    expect(screen.getByTestId('production-save-status')).toHaveAttribute('data-status', 'pending');

    await elapse(SAVE_DEBOUNCE_MS - 1);
    expect(h.updateMutate).not.toHaveBeenCalled();
    await elapse(1);
    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    const [body] = h.updateMutate.mock.calls[0];
    expect(body.timeline.tracks.find((track: { kind: string }) => track.kind === 'captions')).toMatchObject({
      clips: [{ text: 'New caption' }],
    });
  });

  it('holds the save and lists the issue while two clips overlap', async () => {
    vi.useFakeTimers();
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    // Pull the second caption back over the first.
    fireEvent.change(screen.getByTestId('production-inspector-start-input'), { target: { value: '1' } });

    expect(screen.getByTestId('production-save-status')).toHaveAttribute('data-status', 'invalid');
    expect(screen.getByTestId('production-issues')).toBeInTheDocument();
    // The validator flags the later clip of an overlapping pair.
    expect(clipsIn('captions').filter(clip => clip.dataset.invalid === 'true')).toHaveLength(1);
    await elapse(SAVE_DEBOUNCE_MS * 2);
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it('guards navigation only while the unsaved edits cannot be sent on the way out', () => {
    renderEditor(composition());
    expect(h.blocker.options).toMatchObject({ enableBeforeUnload: false });
    expect(h.blocker.options?.shouldBlockFn()).toBe(false);

    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    expect(h.blocker.options).toMatchObject({ enableBeforeUnload: true });
    expect(h.blocker.options?.shouldBlockFn()).toBe(false);

    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    fireEvent.change(screen.getByTestId('production-inspector-start-input'), { target: { value: '1' } });
    expect(h.blocker.options?.shouldBlockFn()).toBe(true);
  });

  it('enables the unload guard for a field edit that has not saved yet', () => {
    renderEditor(composition());
    expect(h.blocker.options).toMatchObject({ enableBeforeUnload: false });

    fireEvent.change(screen.getByTestId('production-brief-summary-input'), { target: { value: 'Cold brew' } });
    expect(h.blocker.options).toMatchObject({ enableBeforeUnload: true });
  });

  it('asks before discarding edits when navigation is blocked', () => {
    h.blocker.status = 'blocked';
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-leave-discard-btn'));
    expect(h.blocker.proceed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('production-leave-cancel-btn'));
    expect(h.blocker.reset).toHaveBeenCalledTimes(1);
  });

  it('builds a shot from Library takes and sends the board to the video track', async () => {
    const takes = ['1', '2'].map(digit => ({
      id: digit.repeat(24),
      fileName: `take-${digit}.mp4`,
      mimeType: 'video/mp4',
      fileUrl: `https://files.test/take-${digit}.mp4`,
    }));
    h.pickedFiles = takes;
    vi.useFakeTimers();
    renderEditor({
      ...composition(),
      shots: [
        { id: 'shot-1', title: 'Hook', intent: 'hook', fileIds: [] },
        { id: 'shot-2', title: 'Product', fileIds: [] },
      ],
    });
    expect(screen.getByTestId('production-shots-send-all-btn')).toBeDisabled();

    fireEvent.click(screen.getByTestId('production-shot-0-add-takes-btn'));
    fireEvent.click(screen.getByTestId('picker-stub-add'));
    const second = `production-shot-0-take-${takes[1].id}`;
    await elapse(0);
    fireEvent.click(screen.getByTestId(`${second}-select-btn`));
    expect(screen.getByTestId(second)).toHaveAttribute('data-selected', 'true');

    fireEvent.click(screen.getByTestId('production-shot-1-down-btn'));
    fireEvent.click(screen.getByTestId('production-shot-0-up-btn'));
    expect(screen.getByTestId('production-shot-0')).toHaveAttribute('data-shot-id', 'shot-1');

    // The take's media kind comes from its Library record, which the thumbnails load.
    await elapse(0);
    expect(screen.getByTestId(second)).toHaveAttribute('title', 'hero.mp4');
    fireEvent.click(screen.getByTestId('production-shots-send-all-btn'));
    await elapse(0);
    expect(clipsIn('video')).toHaveLength(1);

    await elapse(FIELD_AUTOSAVE_DELAY_MS);
    expect(h.updateMutate).toHaveBeenCalledWith({
      shots: [expect.objectContaining({ id: 'shot-1', chosenFileId: takes[1].id }), expect.anything()],
    });
  });

  it('saves the brief as it is typed', async () => {
    vi.useFakeTimers();
    renderEditor(composition());
    fireEvent.change(screen.getByTestId('production-brief-summary-input'), {
      target: { value: 'Cold brew, hot summer' },
    });
    await elapse(FIELD_AUTOSAVE_DELAY_MS);
    expect(h.updateMutate).toHaveBeenCalledWith({ brief: { summary: 'Cold brew, hot summer' } });
    fireEvent.change(screen.getByTestId('production-brief-summary-input'), { target: { value: '' } });
    await elapse(FIELD_AUTOSAVE_DELAY_MS);
    expect(h.updateMutate).toHaveBeenLastCalledWith({ brief: {} });
  });

  it('removes the selected clip from the inspector', () => {
    renderEditor(composition());
    fireEvent.click(screen.getByTestId('production-add-captions-btn'));
    fireEvent.click(screen.getByTestId('production-inspector-remove-btn'));
    expect(clipsIn('captions')).toHaveLength(0);
    expect(screen.getByTestId('production-inspector-empty')).toBeInTheDocument();
  });
});
