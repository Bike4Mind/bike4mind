// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionDetail, ProductionRenderJob, ProductionsApi, ProductionsResult } from '@shared/productions';
import { nextPollDelay, RENDER_POLL } from './renderPolling';
import { StudioProductions } from './StudioProductions';

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const ID = 'c'.repeat(24);
const FILE = 'f'.repeat(24);
const NOW = '2026-11-20T10:00:00.000Z';

const ok = <T,>(value: T): ProductionsResult<T> => ({ ok: true, value });

const detail = (overrides: Partial<ProductionDetail> = {}): ProductionDetail => ({
  id: ID,
  title: 'Launch',
  template: 'ad_campaign',
  updatedAt: NOW,
  durationMs: 15_000,
  outputs: [
    { id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 },
    { id: 'o2', aspectRatio: '9:16', width: 1080, height: 1920 },
  ],
  videoTracks: [
    {
      id: 'v1',
      enabled: true,
      clips: [
        { id: 'a', label: 'Hero shot', startMs: 0, durationMs: 4_000 },
        { id: 'b', label: 'Clip 2', startMs: 4_000, durationMs: 2_000 },
      ],
    },
  ],
  otherClipCount: 0,
  ...overrides,
});

const job = (overrides: Partial<ProductionRenderJob> = {}): ProductionRenderJob => ({
  id: 'j1',
  groupId: 'g1',
  state: 'running',
  progress: 0.5,
  output: { id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 },
  errorMessage: null,
  fileId: null,
  durationSeconds: null,
  createdAt: NOW,
  ...overrides,
});

function fakeApi(overrides: Partial<{ [K in keyof ProductionsApi]: ReturnType<typeof vi.fn> }> = {}) {
  return {
    list: vi.fn(async () =>
      ok({ items: [{ id: ID, title: 'Launch', template: 'ad_campaign' as const, updatedAt: NOW }], nextSkip: null })
    ),
    get: vi.fn(async () => ok(detail())),
    rename: vi.fn(async ({ title }: { title: string }) => ok(detail({ title }))),
    reorder: vi.fn(async () => ok(detail())),
    renders: vi.fn(async () => ok<ProductionRenderJob[]>([])),
    render: vi.fn(async () => ok([job({ id: 'j2', groupId: 'g2', state: 'pending', progress: null })])),
    media: vi.fn(async () => ok({ url: 'b4m-media://productions-cache/x.mp4', mimeType: 'video/mp4' })),
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    auth: { getState: async () => null, onStateChanged: () => () => undefined },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function mount(api: ReturnType<typeof fakeApi>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider>
        <StudioProductions api={api as unknown as ProductionsApi} />
      </CssVarsProvider>
    )
  );
}

const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const flush = () => act(async () => {});

async function openProduction(api: ReturnType<typeof fakeApi>) {
  await mount(api);
  await act(async () => el(`studio-productions-row-${ID}`).click());
  await flush();
}

describe('nextPollDelay', () => {
  it('backs off from the initial delay to the cap', () => {
    expect(nextPollDelay(0)).toBe(RENDER_POLL.initialMs);
    expect(nextPollDelay(1)).toBe(3_000);
    expect(nextPollDelay(50)).toBe(RENDER_POLL.maxMs);
  });
});

describe('StudioProductions', () => {
  it('says Productions is not enabled when the rollout gate refuses', async () => {
    const api = fakeApi({
      list: vi.fn(async () => ({ ok: false, error: { kind: 'not-enabled', message: 'x' } })),
    });
    await mount(api);
    expect(el('studio-productions-not-enabled').textContent).toContain('not enabled for your account');
  });

  it('shows the empty state for an account with no productions', async () => {
    await mount(fakeApi({ list: vi.fn(async () => ok({ items: [], nextSkip: null })) }));
    expect(find('studio-productions-empty')).not.toBeNull();
  });

  it('opens a production and renames it on Enter', async () => {
    const api = fakeApi();
    await openProduction(api);
    expect(find('studio-production-editor')).not.toBeNull();
    const input = el('studio-production-title-input').querySelector('input');
    if (!input) throw new Error('no input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Spring launch');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.blur();
    });
    expect(api.rename).toHaveBeenCalledWith({ id: ID, title: 'Spring launch' });
    await act(async () => el('studio-production-back-btn').click());
    expect(el(`studio-productions-row-${ID}`).textContent).toContain('Spring launch');
  });

  it('moves a clip later by sending the whole new order for its track', async () => {
    const api = fakeApi();
    await openProduction(api);
    await act(async () => el('studio-production-clip-down-a').click());
    expect(api.reorder).toHaveBeenCalledWith({ id: ID, trackId: 'v1', clipIds: ['b', 'a'] });
  });

  it('exports the checked sizes and shows the new job', async () => {
    const started = job({ id: 'j2', groupId: 'g2', state: 'pending', progress: null });
    const renders = vi.fn(async () => ok<ProductionRenderJob[]>([]));
    const api = fakeApi({
      renders,
      render: vi.fn(async () => {
        // The server lists a job as soon as it accepts the export.
        renders.mockResolvedValue(ok([started]));
        return ok([started]);
      }),
    });
    await openProduction(api);
    await act(async () => el('studio-production-output-o2').querySelector('input')?.click());
    await act(async () => el('studio-production-export-btn').click());
    await flush();
    expect(api.render).toHaveBeenCalledWith({ id: ID, outputIds: ['o1'] });
    expect(find('studio-production-render-j2')).not.toBeNull();
  });

  it('shows a refused export with the server message', async () => {
    const api = fakeApi({
      render: vi.fn(async () => ({
        ok: false,
        error: { kind: 'failed', message: 'Starting the export failed: Add a clip first.' },
      })),
    });
    await openProduction(api);
    await act(async () => el('studio-production-export-btn').click());
    expect(el('studio-production-export-error').textContent).toContain('Add a clip first.');
  });

  it('polls an in-flight render with backoff and stops once it is terminal', async () => {
    vi.useFakeTimers();
    const renders = vi
      .fn()
      .mockResolvedValueOnce(ok([job()]))
      .mockResolvedValueOnce(ok([job({ progress: 0.9 })]))
      .mockResolvedValue(ok([job({ state: 'succeeded', progress: 1, fileId: FILE })]));
    const api = fakeApi({ renders });
    await openProduction(api);
    expect(renders).toHaveBeenCalledTimes(1);
    expect(find('studio-production-render-progress-j1')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(nextPollDelay(0)));
    expect(renders).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(nextPollDelay(1)));
    expect(renders).toHaveBeenCalledTimes(3);
    expect(find('studio-production-render-state-succeeded')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(RENDER_POLL.maxMs * 4));
    expect(renders).toHaveBeenCalledTimes(3);
  });

  it('gives up after the poll cap and offers to check again', async () => {
    vi.useFakeTimers();
    const renders = vi.fn(async () => ok([job()]));
    const api = fakeApi({ renders });
    await openProduction(api);
    for (let attempt = 0; attempt < RENDER_POLL.maxPolls + 5; attempt++) {
      await act(async () => vi.advanceTimersByTimeAsync(RENDER_POLL.maxMs));
    }
    expect(renders).toHaveBeenCalledTimes(RENDER_POLL.maxPolls);
    expect(find('studio-production-renders-stalled')).not.toBeNull();
    await act(async () => el('studio-production-renders-refresh-btn').click());
    expect(renders).toHaveBeenCalledTimes(RENDER_POLL.maxPolls + 1);
  });

  it('stops polling when the editor closes', async () => {
    vi.useFakeTimers();
    const renders = vi.fn(async () => ok([job()]));
    const api = fakeApi({ renders });
    await openProduction(api);
    await act(async () => el('studio-production-back-btn').click());
    await act(async () => vi.advanceTimersByTimeAsync(RENDER_POLL.maxMs * 10));
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it('plays a finished export from its local copy', async () => {
    const api = fakeApi({ renders: vi.fn(async () => ok([job({ state: 'succeeded', progress: 1, fileId: FILE })])) });
    await openProduction(api);
    await act(async () => el('studio-production-render-play-j1').click());
    await flush();
    expect(api.media).toHaveBeenCalledWith({ fileId: FILE });
    expect(el('studio-production-render-video').getAttribute('src')).toBe('b4m-media://productions-cache/x.mp4');
  });
});
