// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../../theme';
import type { StudioController, StudioReview } from './controller';
import { StudioPane } from './StudioPane';
import { STUDIO_DOCK_MIN_WIDTH, studioPaneLayout } from './layout';
import { IMAGE_MODEL_CATALOG } from '@bike4mind/common';
import type { StudioLiveState } from '@shared/studioIpc';
import { useStudioController } from './useStudioController';

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
// The payer note under Generate asks main who pays; left pending, it renders nothing.
beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    account: { getSelection: () => new Promise(() => {}), onSelectionChanged: () => () => {} },
  };
});

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
async function mount(
  value?: StudioController,
  variant: 'docked' | 'stacked' = 'docked',
  onClose = vi.fn(),
  unavailableReason?: string
) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <StudioPane controller={value} variant={variant} onClose={onClose} unavailableReason={unavailableReason} />
      </CssVarsProvider>
    )
  );
  return onClose;
}

describe('Studio layout', () => {
  it('stacks without an overlay when a usable chat column and Studio do not fit', () => {
    expect(studioPaneLayout(null)).toBe('docked');
    expect(studioPaneLayout(0)).toBe('stacked');
    expect(studioPaneLayout(STUDIO_DOCK_MIN_WIDTH - 1)).toBe('stacked');
    expect(studioPaneLayout(STUDIO_DOCK_MIN_WIDTH)).toBe('docked');
  });
  it('renders a labelled nonmodal stacked pane that Escape dismisses', async () => {
    const close = await mount(undefined, 'stacked');
    expect(get('studio-pane').dataset.variant).toBe('stacked');
    expect(get('studio-pane').tagName).toBe('ASIDE');
    expect(get('studio-pane').getAttribute('aria-labelledby')).toBe('studio-pane-title');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(get('studio-pane').closest('[aria-hidden="true"]')).toBeNull();
    await act(async () =>
      get('studio-close-btn').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(close).toHaveBeenCalled();
  });
});

describe('Studio states', () => {
  it('shows real image model/count controls and preserves settings through model changes', async () => {
    const value = controller({
      catalog: {
        images: [
          { id: 'gpt-image-2', name: 'GPT Image 2', capabilities: IMAGE_MODEL_CATALOG['gpt-image-2'] },
          { id: 'flux-pro-1.1', name: 'Flux Pro', capabilities: IMAGE_MODEL_CATALOG['flux-pro-1.1'] },
        ],
        videos: [],
        music: [],
        speech: [],
        soundEffects: [],
        voices: [],
      },
    });
    await mount(value);
    await click('studio-create-image-tile');
    expect((get('studio-setting-model') as HTMLSelectElement).value).toBe('gpt-image-2');
    expect(get('studio-creation-back-btn').textContent).toBe('');
    expect(get('studio-creation-back-btn').getAttribute('aria-label')).toBe('Back to Studio');
    expect(get('studio-creation-form').textContent).not.toContain('Wet slate');
    expect(get('studio-creation-form').textContent).not.toContain('Kitchen counter');
    await input('studio-setting-count', '3');
    await input('studio-setting-size', '1024x1024');
    await input('studio-setting-quality', 'high');
    await input('studio-setting-model', 'flux-pro-1.1');
    expect((get('studio-setting-quality') as HTMLSelectElement).value).toBe('high');
    await input('studio-prompt-input', 'Three bicycles');
    await click('studio-generate-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ model: 'flux-pro-1.1', count: 3, size: '1024x1024', quality: 'high' }),
      })
    );
  });
  it.each(['settings', 'model', 'revision'] as const)(
    'preserves newer %s when a reference upload finishes',
    async change => {
      let finishUpload: (value: { fileId: string; name: string } | null) => void = () => {};
      const upload = new Promise<{ fileId: string; name: string } | null>(resolve => {
        finishUpload = resolve;
      });
      const value = controller({
        uploadReference: vi.fn(() => upload),
        catalog: {
          images: [
            { id: 'gpt-image-2', name: 'GPT Image 2', capabilities: IMAGE_MODEL_CATALOG['gpt-image-2'] },
            { id: 'flux-pro-1.1', name: 'Flux Pro', capabilities: IMAGE_MODEL_CATALOG['flux-pro-1.1'] },
          ],
          videos: [],
          music: [],
          speech: [],
          soundEffects: [],
          voices: [],
        },
      });
      await mount(value);
      await click('studio-create-image-tile');
      await input('studio-prompt-input', 'Before upload');
      await click('studio-upload-reference-btn');
      if (change === 'model') await input('studio-setting-model', 'flux-pro-1.1');
      else if (change === 'revision') await mount({ ...value, revision: '2' });
      else await input('studio-setting-count', '3');
      await input('studio-prompt-input', 'Edited while uploading');
      await act(async () => finishUpload({ fileId: 'reference', name: 'Uploaded image.png' }));
      expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Edited while uploading');
      expect((get('studio-setting-model') as HTMLSelectElement).value).toBe(
        change === 'model' ? 'flux-pro-1.1' : 'gpt-image-2'
      );
      if (change === 'settings') {
        expect((get('studio-setting-count') as HTMLSelectElement).value).toBe('3');
        expect(get('studio-model-settings').textContent).toContain('Uploaded image.png');
      } else {
        expect(get('studio-model-settings').textContent).not.toContain('Uploaded image.png');
        expect(get('studio-model-settings').textContent).toContain('Settings changed');
      }
    }
  );
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
    await click('studio-asset-actions-btn');
    await click('studio-asset-reuse-btn');
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Saved prompt');
    expect(value.prepareCreation).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
    await click('studio-generate-btn');
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
    expect(get('studio-empty').textContent).toBe('Your creations will appear here.');
    expect(get('studio-pane').textContent).not.toContain('30 days');
    expect(get('studio-pane').textContent).not.toContain('Automatic recovery');
    await mount(controller({ state: { status: 'loading' } }));
    expect(get('studio-loading').getAttribute('role')).toBe('status');
    await mount(controller({ state: { status: 'error', error: 'Offline' } }));
    expect(get('studio-load-error').textContent).toBe('Offline');
  });
  it('prepares the current session context and dispatches the prepared Voice script once', async () => {
    const value = controller();
    await mount(value);
    await click('studio-create-speech-tile');
    await input('studio-prompt-input', 'Read this');
    expect((get('studio-use-session-context-checkbox') as HTMLInputElement).checked).toBe(true);
    await click('studio-generate-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech',
        prompt: 'Read this',
        selection: { mode: 'current-session' },
        sessionId: 's1',
        workspaceId: 'w1',
        revision: '1',
      })
    );
    expect(value.create).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 'review-1', preparedPrompt: 'Prepared script' })
    );
    expect(value.create).toHaveBeenCalledTimes(1);
    expect(find('studio-creation-form')).toBeNull();
  });
  it('can generate without session context and exposes no custom source picker', async () => {
    const value = controller();
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'A garden');
    await click('studio-use-session-context-checkbox');
    expect(find('studio-context-select')).toBeNull();
    expect(find('studio-pick-files-btn')).toBeNull();
    await click('studio-generate-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(expect.objectContaining({ selection: { mode: 'none' } }));
    expect(find('studio-context-review')).toBeNull();
  });
  it('locks edits while preparing and discards preparation after revision changes', async () => {
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
    await click('studio-generate-btn');
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((get('studio-prompt-input') as HTMLTextAreaElement).disabled).toBe(true);
    await mount({ ...value, revision: '2' });
    await act(async () => finish(review));
    expect(value.create).not.toHaveBeenCalled();
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Before');
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(false);
  });
  it('lists jobs chronologically and shows images inline with a collapsed prompt and action menu', async () => {
    const asset = {
      id: 'a1',
      kind: 'image' as const,
      title: 'Garden',
      prompt: 'A peaceful garden with flowers',
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
    expect(get('studio-asset-list').firstElementChild?.textContent).toContain('Creating...');
    await click('studio-asset-a1-btn');
    expect((get('studio-asset-export-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((get('studio-asset-image') as HTMLImageElement).src).toBe(asset.url);
    expect(find('studio-asset-preview-btn')).toBeNull();
    expect(get('studio-asset-toggle-prompt-btn').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('studio-asset-prompt')).toBeNull();
    await click('studio-asset-toggle-prompt-btn');
    expect(document.getElementById('studio-asset-prompt')?.textContent).toBe(asset.prompt);
    await click('studio-asset-toggle-prompt-btn');
    expect(document.getElementById('studio-asset-prompt')).toBeNull();
    await click('studio-asset-actions-btn');
    expect(get('studio-asset-delete-btn').getAttribute('role')).toBe('menuitem');
    expect(preview).not.toHaveBeenCalled();
  });
  it('discards preparation when submission becomes busy and keeps background refresh independent', async () => {
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
    await input('studio-prompt-input', 'Garden');
    await click('studio-generate-btn');
    await mount({ ...value, state: { status: 'loading' } });
    expect(get('studio-creation-form')).toBeTruthy();
    await mount({ ...value, busy: true });
    await act(async () => finish(review));
    expect(value.create).not.toHaveBeenCalled();
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(true);
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
    await click('studio-generate-btn');
    expect(value.prepareCreation).not.toHaveBeenCalled();
    await input('studio-setting-durationSeconds', '5');
    await click('studio-generate-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', settings: { durationSeconds: 5 } })
    );
    expect(find('studio-setting-resolution')).toBeNull();
  });
});

describe('Studio QA draft ownership', () => {
  it('keeps the same prompt, context choice and settings when the conversation model changes', async () => {
    const value = controller({
      capabilities: {
        image: { status: 'available', fields: [{ key: 'count', label: 'Count', type: 'number', min: 1, max: 4 }] },
      },
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Keep my draft');
    await input('studio-setting-count', '3');
    await click('studio-use-session-context-checkbox');
    const prompt = get('studio-prompt-input');
    await mount({ ...value, revision: '2' });
    expect(get('studio-prompt-input')).toBe(prompt);
    expect((prompt as HTMLTextAreaElement).value).toBe('Keep my draft');
    expect((get('studio-use-session-context-checkbox') as HTMLInputElement).checked).toBe(false);
    expect((get('studio-setting-count') as HTMLInputElement).value).toBe('3');
    expect(get('studio-context-changed').textContent).toContain('draft');
    await click('studio-generate-btn');
    expect(value.prepareCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: '2',
        prompt: 'Keep my draft',
        selection: { mode: 'none' },
        settings: { count: 3 },
      })
    );
    expect(value.create).toHaveBeenCalledTimes(1);
  });

  it('keeps a paid creation locked until it settles even when the revision changes', async () => {
    let finish = () => {};
    const value = controller({
      create: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          })
      ),
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Keep while creating');
    await click('studio-generate-btn');
    expect(value.create).toHaveBeenCalledTimes(1);
    await mount({ ...value, revision: '2' });
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Keep while creating');
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(true);
    await click('studio-generate-btn');
    expect(value.create).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(false);
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Keep while creating');
    expect(get('studio-context-changed').textContent).toContain('check Your creations');
  });

  it('explains a preparation failure with context off and preserves the original error and draft', async () => {
    const value = controller({
      prepareCreation: vi.fn(async () => {
        throw new Error('Selected model is unavailable');
      }),
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Keep after failure');
    await click('studio-use-session-context-checkbox');
    await click('studio-generate-btn');
    expect(get('studio-creation-error').textContent).toContain("conversation's chat model");
    expect(get('studio-creation-error').textContent).toContain('Selected model is unavailable');
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Keep after failure');
    expect((get('studio-use-session-context-checkbox') as HTMLInputElement).checked).toBe(false);
    expect(value.create).not.toHaveBeenCalled();
    expect((get('studio-generate-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps creation-stage errors distinct from prompt preparation errors', async () => {
    const value = controller({
      create: vi.fn(async () => {
        throw new Error('Submission outcome unknown');
      }),
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Keep after uncertain submission');
    await click('studio-generate-btn');
    expect(get('studio-creation-error').textContent).toBe('Submission outcome unknown');
    expect(value.create).toHaveBeenCalledTimes(1);
  });

  // An explicit selection passes through as current-session does; undefined is the fallback branch.
  it.each([
    ['current-session', true],
    [undefined, false],
  ] as const)(
    'restores saved context selection %s without submitting or silently adding context',
    async (mode, checked) => {
      const asset = {
        id: 'saved',
        kind: 'image' as const,
        title: 'Saved',
        originatingSessionId: 's1',
        createdAt: '2026-11-01',
        updatedAt: '2026-11-01',
        url: 'https://example.com/image.png',
        creation: { prompt: 'Prepared saved prompt', settings: { count: 2 }, ...(mode ? { selection: { mode } } : {}) },
      };
      const value = controller({ state: { status: 'ready', assets: [asset], jobs: [] } });
      await mount(value);
      await click('studio-asset-saved-btn');
      await click('studio-asset-actions-btn');
      await click('studio-asset-reuse-btn');
      expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Prepared saved prompt');
      expect((get('studio-use-session-context-checkbox') as HTMLInputElement).checked).toBe(checked);
      expect(value.prepareCreation).not.toHaveBeenCalled();
      expect(value.create).not.toHaveBeenCalled();
      await click('studio-generate-btn');
      expect(value.prepareCreation).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { mode: mode ?? 'none' }, settings: { count: 2 } })
      );
    }
  );
});

describe('Studio QA empty state and paid completion', () => {
  it('keeps fresh conversation tiles disabled and explains how to start', async () => {
    await mount(
      undefined,
      'docked',
      vi.fn(),
      'Send a message to start a conversation, then open Studio to create media.'
    );
    expect(get('studio-unavailable').textContent).toContain('Send a message to start a conversation');
    for (const kind of ['image', 'video', 'music', 'speech', 'sound-effect']) {
      const tile = get(`studio-create-${kind}-tile`) as HTMLButtonElement;
      expect(tile.disabled).toBe(true);
      expect(tile.title).toContain('Send a message to start a conversation');
    }
  });

  it('keeps an uncertain paid error visible after the context revision changes', async () => {
    let fail: (cause: Error) => void = () => {};
    const value = controller({
      create: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          })
      ),
    });
    await mount(value);
    await click('studio-create-image-tile');
    await input('studio-prompt-input', 'Keep uncertain draft');
    await click('studio-generate-btn');
    await mount({ ...value, revision: '2' });
    await act(async () => fail(new Error('Submission outcome unknown')));
    expect(get('studio-creation-error').textContent).toBe('Submission outcome unknown');
    expect(get('studio-context-changed').textContent).not.toContain('generate again');
    expect(value.create).toHaveBeenCalledTimes(1);
    expect((get('studio-prompt-input') as HTMLTextAreaElement).value).toBe('Keep uncertain draft');
  });
});

describe('useStudioController', () => {
  it('does not let an older refresh replace a newly loaded history page', async () => {
    const state: StudioLiveState = {
      sessionId: 'first',
      revision: 'revision',
      available: true,
      sessions: [],
      workspace: { workspaceId: 'family', rootSessionId: 'first', assets: [], jobs: [], nextAssetCursor: 'cursor' },
    };
    let refresh!: () => void;
    let resolveRefresh!: (value: StudioLiveState) => void;
    const get = vi
      .fn()
      .mockResolvedValueOnce(structuredClone(state))
      .mockImplementation(
        () =>
          new Promise<StudioLiveState>(resolve => {
            resolveRefresh = resolve;
          })
      );
    const original = window.b4m;
    Object.defineProperty(window, 'b4m', {
      configurable: true,
      value: {
        studio: {
          get,
          onChanged: (listener: () => void) => {
            refresh = listener;
            return () => {};
          },
          page: async () => ({
            collection: 'assets',
            items: [
              {
                id: 'extra',
                kind: 'image',
                title: 'Extra',
                originatingSessionId: 'first',
                createdAt: '',
                updatedAt: '',
                url: '',
              },
            ],
          }),
        },
        auth: { onStateChanged: () => () => {} },
      },
    });
    const root = createRoot(document.createElement('div'));
    let controller: StudioController | undefined;
    function Probe() {
      controller = useStudioController('first', true);
      return null;
    }
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => refresh());
      await act(async () => controller!.loadMore!('assets'));
      await act(async () => resolveRefresh(structuredClone(state)));
      expect(controller!.state).toEqual(
        expect.objectContaining({ assets: [expect.objectContaining({ id: 'extra' })] })
      );
    } finally {
      act(() => root.unmount());
      Object.defineProperty(window, 'b4m', { configurable: true, value: original });
    }
  });

  it('discards delayed workspace state and callbacks after a session switch', async () => {
    let resolveFirst!: (state: StudioLiveState) => void;
    const get = vi.fn((id: string) =>
      id === 'first'
        ? new Promise<StudioLiveState>(resolve => {
            resolveFirst = resolve;
          })
        : Promise.resolve({
            sessionId: id,
            revision: 'revision',
            workspace: { workspaceId: id, rootSessionId: id, assets: [], jobs: [] },
            sessions: [],
            available: true,
          })
    );
    const original = window.b4m;
    Object.defineProperty(window, 'b4m', {
      configurable: true,
      value: { studio: { get, onChanged: () => () => {} }, auth: { onStateChanged: () => () => {} } },
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    let controller: StudioController | undefined;
    function Probe({ id }: { id: string }) {
      controller = useStudioController(id, true);
      return null;
    }
    try {
      await act(async () => root.render(<Probe id="first" />));
      const stale = controller!;
      await act(async () => root.render(<Probe id="second" />));
      await act(async () =>
        resolveFirst({
          sessionId: 'first',
          revision: 'old',
          workspace: { workspaceId: 'first', rootSessionId: 'first', assets: [], jobs: [] },
          sessions: [],
          available: true,
        })
      );
      expect(controller!.sessionId).toBe('second');
      expect(controller!.workspaceId).toBe('second');
      await expect(stale.pickFiles!()).rejects.toThrow('Studio session changed');
    } finally {
      act(() => root.unmount());
      Object.defineProperty(window, 'b4m', { configurable: true, value: original });
    }
  });
});
