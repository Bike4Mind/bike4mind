// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  HubDetailResult,
  HubModelView,
  HubSearchResult,
  InstalledModelsResult,
  ModelPull,
  ModelRuntimeStatus,
} from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ModelsScreen } from './ModelsScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const RUNNING: ModelRuntimeStatus = { reachable: true, version: '0.40.11', url: 'http://127.0.0.1:11434', error: null };
const DOWN: ModelRuntimeStatus = { reachable: false, version: null, url: 'http://127.0.0.1:11434', error: 'refused' };
const capabilities = { tools: true, vision: false, thinking: false, embeddings: false, completion: true };

function card(id: string, extra: Partial<HubModelView> = {}) {
  return {
    id,
    author: id.split('/')[0],
    downloads: 12_345,
    likes: 67,
    updatedAt: null,
    license: 'apache-2.0',
    gated: false as const,
    private: false,
    abliterated: false,
    ...extra,
  };
}

function view(extra: Partial<HubModelView> = {}): HubModelView {
  return {
    ...card(REPO),
    url: `https://huggingface.co/${REPO}`,
    revision: 'abc',
    licenseName: 'apache-2.0',
    licenseUrl: `https://huggingface.co/${REPO}`,
    licenseKind: 'permissive',
    baseModels: [],
    builds: [
      {
        id: 'qwen2.5-0.5b-instruct-q4_k_m',
        quant: 'Q4_K_M',
        sizeBytes: 491_400_032,
        ollamaRef: `hf.co/${REPO}:Q4_K_M`,
        blockedReason: null,
      },
    ],
    projectorBytes: null,
    needsAccess: false,
    ...extra,
  };
}

interface Bridge {
  status: ModelRuntimeStatus;
  installed: InstalledModelsResult;
  search: HubSearchResult;
  detail: HubDetailResult;
  pulls: ModelPull[];
}

let bridge: Bridge;
let pushPulls: (pulls: ModelPull[]) => void = () => {};
const calls = {
  pull: vi.fn(),
  cancelPull: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
};

beforeEach(() => {
  bridge = {
    status: RUNNING,
    installed: { ok: true, models: [] },
    search: { ok: true, models: [card(REPO)], nextCursor: null },
    detail: { ok: true, model: view() },
    pulls: [],
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.pull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  calls.remove.mockResolvedValue({ ok: true });
  (window as unknown as { b4m: unknown }).b4m = {
    shell: { openExternal: vi.fn() },
    models: {
      getStatus: async () => bridge.status,
      listInstalled: async () => bridge.installed,
      search: async (request: unknown) => {
        calls.search(request);
        return bridge.search;
      },
      getDetail: async () => bridge.detail,
      listPulls: async () => bridge.pulls,
      pull: calls.pull,
      cancelPull: calls.cancelPull,
      dismissPull: vi.fn(),
      remove: calls.remove,
      onPullsChanged: (listener: (pulls: ModelPull[]) => void) => {
        pushPulls = listener;
        return () => {};
      },
      onInstalledChanged: () => () => {},
    },
  };
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelsScreen onClose={() => {}} />
      </CssVarsProvider>
    )
  );
  await flush();
  await flush();
  // The screen remembers its tab across visits, and so across tests.
  await click(q('models-installed-tab'));
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const click = async (element: HTMLElement | null) => {
  if (!element) throw new Error('missing element');
  act(() => element.click());
  await flush();
  await flush();
};

async function openExplore() {
  await click(q('models-explore-tab'));
}

describe('ModelsScreen installed', () => {
  it('shows the empty state and leads to Explore', async () => {
    await mount();
    expect(q('models-runtime-status')?.dataset.state).toBe('running');
    expect(q('models-installed-empty')).not.toBeNull();
    await click(q('models-installed-explore-btn'));
    expect(calls.search).toHaveBeenCalled();
  });

  it('lists models with the loaded marker and removes one after confirming', async () => {
    bridge.installed = {
      ok: true,
      models: [
        {
          name: 'qwen2.5:0.5b',
          sizeBytes: 397_000_000,
          quantization: 'Q4_K_M',
          family: 'qwen2',
          parameterSize: '494M',
          modifiedAt: null,
          capabilities,
          loaded: true,
        },
      ],
    };
    await mount();
    expect(all('models-installed-row').map(row => row.dataset.name)).toEqual(['qwen2.5:0.5b']);
    expect(q('models-installed-loaded-chip')).not.toBeNull();
    expect(q('models-installed-row')?.textContent).toContain('Q4_K_M');

    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog')).not.toBeNull();
    expect(calls.remove).not.toHaveBeenCalled();
    await click(q('models-remove-dialog-confirm-btn'));
    expect(calls.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
  });

  it('says plainly when Ollama is not running, and Explore still works without pulls', async () => {
    bridge.status = DOWN;
    await mount();
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
    expect(q('models-installed-runtime-down')?.textContent).toContain('Ollama is not running');
    expect(q('models-runtime-download-link')?.getAttribute('href')).toBe('https://ollama.com/download');

    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-detail-runtime-down')).not.toBeNull();
    expect(q('models-build-pull-btn')?.hasAttribute('disabled')).toBe(true);
  });
});

describe('ModelsScreen explore', () => {
  it('hides abliterated results until the toggle is on, then labels them', async () => {
    bridge.search = {
      ok: true,
      models: [card(REPO), card('someone/Qwen2.5-7B-abliterated-GGUF', { abliterated: true })],
      nextCursor: null,
    };
    await mount();
    await openExplore();
    expect(all('models-explore-result-row').map(row => row.dataset.repo)).toEqual([REPO]);
    expect(q('models-explore-hidden-note')?.textContent).toContain('1 abliterated result is hidden');

    await click(q('models-explore-abliterated-switch'));
    expect(all('models-explore-result-row')).toHaveLength(2);
    expect(q('models-explore-abliterated-chip')).not.toBeNull();
    await click(q('models-explore-abliterated-switch'));
    expect(all('models-explore-result-row')).toHaveLength(1);
  });

  it('shows the license before the download button and asks before pulling', async () => {
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));

    const detail = q('models-detail');
    const license = q('models-detail-license');
    const button = q('models-build-pull-btn');
    expect(q('models-detail-license-chip')?.textContent).toBe('apache-2.0');
    expect(
      license && button && license.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(detail?.textContent).toContain('491 MB');

    await click(button);
    expect(q('models-pull-dialog-size')?.textContent).toContain('491 MB download');
    await click(q('models-pull-dialog-cancel-btn'));
    expect(q('models-pull-dialog')).toBeNull();
    expect(calls.pull).not.toHaveBeenCalled();

    await click(q('models-build-pull-btn'));
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith({
      repo: REPO,
      buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
      acceptLicense: false,
      confirmAccess: false,
    });
  });

  it('needs the restricted license acknowledged before the download is offered', async () => {
    bridge.detail = {
      ok: true,
      model: view({ license: 'llama3.2', licenseName: 'llama3.2', licenseKind: 'restricted' }),
    };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-detail-license')?.dataset.kind).toBe('restricted');

    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-license-link')).not.toBeNull();
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
    await click(q('models-pull-dialog-license-checkbox'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(false);
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith(expect.objectContaining({ acceptLicense: true }));
  });

  it('explains the access steps for a gated repo', async () => {
    bridge.detail = {
      ok: true,
      model: view({
        gated: 'manual',
        needsAccess: true,
        builds: [{ ...view().builds[0], blockedReason: 'Needs access: Hugging Face hides this file.' }],
      }),
    };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-access-steps')?.textContent).toContain('Request access');
    expect(q('models-access-keys-link')?.getAttribute('href')).toBe('https://huggingface.co/settings/keys');
    expect(q('models-build-blocked-reason')?.textContent).toContain('Needs access');
    expect(q('models-build-pull-btn')).toBeNull();
  });

  it('shows progress for a pull in flight and cancels it', async () => {
    await mount();
    act(() =>
      pushPulls([
        {
          key: `${REPO}#qwen2.5-0.5b-instruct-q4_k_m`,
          repo: REPO,
          buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
          quant: 'Q4_K_M',
          ref: `hf.co/${REPO}:Q4_K_M`,
          phase: 'downloading',
          completedBytes: 245_700_016,
          totalBytes: 491_400_032,
          expectedBytes: 491_400_032,
          error: null,
        },
      ])
    );
    expect(q('models-pull-status')?.textContent).toContain('(50%)');
    await click(q('models-pull-cancel-btn'));
    expect(calls.cancelPull).toHaveBeenCalledWith(`${REPO}#qwen2.5-0.5b-instruct-q4_k_m`);

    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-build-progress')).not.toBeNull();
  });

  it.each([
    [{ kind: 'hub-unreachable' as const, message: 'Could not reach Hugging Face.' }, 'Could not reach Hugging Face.'],
    [{ kind: 'rate-limited' as const, message: 'x', retryAfterMs: 30_000 }, 'Try again in 30 seconds'],
  ])('shows a search failure (%o)', async (error, text) => {
    bridge.search = { ok: false, error };
    await mount();
    await openExplore();
    expect(q('models-explore-error')?.textContent).toContain(text);
  });

  it('says when nothing matches', async () => {
    bridge.search = { ok: true, models: [], nextCursor: null };
    await mount();
    await openExplore();
    const input = q('models-explore-search-input') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'nothing-here');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('models-explore-search-btn'));
    expect(calls.search).toHaveBeenLastCalledWith({ query: 'nothing-here' });
    expect(q('models-explore-empty')?.textContent).toBe('No GGUF models match "nothing-here".');
  });
});
