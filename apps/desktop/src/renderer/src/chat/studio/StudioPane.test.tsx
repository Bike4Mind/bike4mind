// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../../theme';
import type { StudioController, StudioReview } from './controller';
import { StudioPane } from './StudioPane';
import { STUDIO_DOCK_MIN_WIDTH, studioPaneLayout } from './layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const get = (id: string) => {
  const node = find(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node;
};
const click = (id: string) => act(async () => get(id).click());
async function input(id: string, value: string) {
  await act(async () => {
    const node = get(id);
    const prototype =
      node.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : node.tagName === 'INPUT'
          ? HTMLInputElement.prototype
          : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, value);
    node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const review: StudioReview = {
  id: 'review-1',
  preparedPrompt: 'Prepared script',
  sources: [{ sessionId: 's1', title: 'First session' }],
  exclusions: ['Private source'],
  truncation: ['Long source'],
  warnings: [],
};
function controller(overrides: Partial<StudioController> = {}): StudioController {
  return {
    sessionId: 's1',
    workspaceId: 'w1',
    revision: '1',
    familyLabel: 'Shared family',
    sessions: [{ id: 's1', title: 'First session' }],
    capabilities: {
      image: { status: 'available' },
      speech: { status: 'available' },
      video: { status: 'unsupported', reason: 'Video is not supported.' },
      music: { status: 'loading', reason: 'Loading models.' },
    },
    state: { status: 'ready', assets: [], jobs: [] },
    prepareCreation: vi.fn(async () => review),
    create: vi.fn(async () => undefined),
    ...overrides,
  };
}
async function mount(value?: StudioController, variant: 'docked' | 'drawer' = 'docked', onClose = vi.fn()) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <StudioPane controller={value} variant={variant} onClose={onClose} />
      </CssVarsProvider>
    )
  );
  return onClose;
}

describe('Studio layout', () => {
  it('uses a drawer until a full reading column and Studio fit', () => {
    expect(studioPaneLayout(null)).toBe('drawer');
    expect(studioPaneLayout(0)).toBe('drawer');
    expect(studioPaneLayout(STUDIO_DOCK_MIN_WIDTH - 1)).toBe('drawer');
    expect(studioPaneLayout(STUDIO_DOCK_MIN_WIDTH)).toBe('docked');
  });
  it('renders a labelled drawer that Escape dismisses', async () => {
    const close = await mount(undefined, 'drawer');
    expect(get('studio-pane').dataset.variant).toBe('drawer');
    expect(get('studio-pane').getAttribute('role')).toBe('dialog');
    expect(get('studio-pane').closest('[aria-hidden="true"]')).toBeNull();
    await act(async () =>
      get('studio-close-btn').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(close).toHaveBeenCalled();
  });
});

describe('Studio states', () => {
  it('loads remaining history pages and prefills reusable settings without submitting', async () => {
    const loadMore = vi.fn(async () => undefined);
    const value = controller({
      hasMoreAssets: true,
      hasMoreJobs: true,
      loadMore,
      state: {
        status: 'ready',
        jobs: [],
        assets: [
          {
            id: 'saved',
            kind: 'image',
            title: 'Saved',
            originatingSessionId: 's1',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            url: 'b4m-media://media/bucket/image.png',
            creation: { prompt: 'Saved prompt', settings: { size: '1024x1024', model: 'saved-model' } },
          },
        ],
      },
    });
    await mount(value);
    await click('studio-load-more-assets-btn');
    expect(loadMore).toHaveBeenCalledWith('assets');
    await click('studio-load-more-jobs-btn');
    expect(loadMore).toHaveBeenCalledWith('jobs');
    await click('studio-asset-saved-btn');
    await click('studio-asset-reuse-btn');
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Saved prompt');
    expect(value.prepareCreation).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
    await click('studio-prepare-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { size: '1024x1024', model: 'saved-model' } })
    );
  });
  it('shows five accessible tiles and honest unavailable reasons without services', async () => {
    await mount();
    for (const kind of ['image', 'video', 'music', 'speech', 'sound-effect'])
      expect((get(`studio-create-${kind}-tile`) as HTMLButtonElement).disabled).toBe(true);
    expect(get('studio-unavailable').textContent).toContain('not connected');
    expect(find('studio-empty')).toBeNull();
  });
  it('distinguishes unsupported/loading capabilities and empty/loading/error lists', async () => {
    await mount(controller());
    expect(get('studio-creation-tiles').textContent).toContain('Video is not supported.');
    expect(get('studio-creation-tiles').textContent).toContain('Loading models.');
    expect(get('studio-empty')).toBeTruthy();
    await mount(controller({ state: { status: 'loading' } }));
    expect(get('studio-loading').getAttribute('role')).toBe('status');
    await mount(controller({ state: { status: 'error', error: 'Offline' } }));
    expect(get('studio-load-error').textContent).toBe('Offline');
  });
  it('reviews context and editable Voice script before dispatching create', async () => {
    const value = controller();
    await mount(value);
    await click('studio-create-speech-tile');
    await input('studio-prompt-input', 'Read this');
    expect((get('studio-context-select') as HTMLSelectElement).value).toBe('session-family');
    await click('studio-prepare-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech',
        prompt: 'Read this',
        selection: { mode: 'session-family' },
        sessionId: 's1',
        workspaceId: 'w1',
        revision: '1',
      })
    );
    expect(get('studio-context-review').textContent).toContain('Excluded: Private source');
    expect(get('studio-context-review').textContent).toContain('Truncated: Long source');
    await input('studio-prepared-input', 'Edited script');
    await click('studio-create-btn');
    expect(value.create).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'review-1', preparedPrompt: 'Edited script' })
    );
    expect(find('studio-creation-form')).toBeNull();
  });
  it('requires explicit custom selection and invalidates review on scope edits', async () => {
    await mount(controller());
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'A garden');
    await click('studio-prepare-btn');
    await input('studio-context-select', 'custom');
    expect(find('studio-context-review')).toBeNull();
    expect((get('studio-prepare-btn') as HTMLButtonElement).disabled).toBe(true);
    await click('studio-context-s1-checkbox');
    expect((get('studio-prepare-btn') as HTMLButtonElement).disabled).toBe(false);
  });
  it('discards an in-flight prepare after prompt edits and revision changes', async () => {
    let finish: (result: StudioReview) => void = () => undefined;
    const value = controller({
      prepareCreation: vi.fn(
        () =>
          new Promise<StudioReview>(resolve => {
            finish = resolve;
          })
      ),
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Before');
    await click('studio-prepare-btn');
    await input('studio-prompt-input', 'After');
    await act(async () => finish(review));
    expect(find('studio-context-review')).toBeNull();
    await click('studio-prepare-btn');
    await mount({ ...value, revision: '2' });
    await act(async () => finish(review));
    expect(find('studio-context-review')).toBeNull();
  });
  it('lists jobs chronologically and exposes disabled or live preview actions', async () => {
    const asset = {
      id: 'a1',
      kind: 'image' as const,
      title: 'Garden',
      originatingSessionId: 's1',
      createdAt: '2026-11-01',
      updatedAt: '2026-11-01',
      url: 'https://example.com/image.png',
    };
    const preview = vi.fn(async () => undefined);
    await mount(
      controller({
        previewAsset: preview,
        state: {
          status: 'ready',
          assets: [asset],
          jobs: [
            {
              id: 'j1',
              kind: 'video',
              originatingSessionId: 's1',
              state: 'running',
              createdAt: '2026-11-02',
              updatedAt: '2026-11-02',
              idempotencyKey: 'key',
              assetIds: [],
            },
          ],
        },
      })
    );
    expect(get('studio-asset-list').firstElementChild?.textContent).toContain('running');
    await click('studio-asset-a1-btn');
    expect((get('studio-asset-export-btn') as HTMLButtonElement).disabled).toBe(true);
    await click('studio-asset-preview-btn');
    expect(preview).toHaveBeenCalledWith(asset);
  });
  it('invalidates reviews when submission becomes busy and keeps background jobs independent', async () => {
    const value = controller();
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Garden');
    await click('studio-prepare-btn');
    await mount({ ...value, state: { status: 'loading' } });
    expect(get('studio-context-review')).toBeTruthy();
    await mount({ ...value, busy: true });
    expect(find('studio-context-review')).toBeNull();
    expect((get('studio-prepare-btn') as HTMLButtonElement).disabled).toBe(true);
  });
  it('does not duplicate delivered jobs alongside their assets', async () => {
    const job = {
      id: 'j1',
      kind: 'image' as const,
      originatingSessionId: 's1',
      state: 'completed' as const,
      createdAt: '2026-11-02',
      updatedAt: '2026-11-02',
      idempotencyKey: 'key',
      assetIds: ['a1'],
    };
    await mount(
      controller({
        state: {
          status: 'ready',
          assets: [
            {
              id: 'a1',
              kind: 'image',
              title: 'Garden',
              originatingSessionId: 's1',
              createdAt: '2026-11-02',
              updatedAt: '2026-11-02',
              url: 'https://example.com/image.png',
            },
          ],
          jobs: [job],
        },
      })
    );
    expect(find('studio-job-j1')).toBeNull();
    expect(get('studio-asset-a1-btn')).toBeTruthy();
  });
  it('only exposes supplied modality settings and validates numeric limits', async () => {
    const value = controller({
      capabilities: {
        video: {
          status: 'available',
          fields: [{ key: 'durationSeconds', label: 'Duration', type: 'number', min: 3, max: 10 }],
        },
      },
    });
    await mount(value);
    await click('studio-create-video-tile');
    await input('studio-prompt-input', 'A garden');
    await input('studio-setting-durationSeconds', '20');
    await click('studio-prepare-btn');
    expect(value.prepareCreation).not.toHaveBeenCalled();
    await input('studio-setting-durationSeconds', '5');
    await click('studio-prepare-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', settings: { durationSeconds: 5 } })
    );
    expect(find('studio-setting-resolution')).toBeNull();
  });
});
