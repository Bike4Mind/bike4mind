// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type {
  HfTokenStatus,
  HubDetailResult,
  HubModelView,
  HubSearchResult,
  InstalledModelsResult,
  ModelPull,
  ModelRuntimeStatus,
} from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import type { ModelsInUse } from './InstalledTab';
import { ModelsScreen } from './ModelsScreen';
import { DOWN_RECHECK_MS } from './useModelHub';

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
    licenses: ['apache-2.0'],
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
    licenseNames: ['apache-2.0'],
    licenseUrl: `https://huggingface.co/${REPO}`,
    licenseHost: 'huggingface.co',
    licenseKind: 'permissive',
    baseModels: [],
    builds: [
      {
        id: 'qwen2.5-0.5b-instruct-q4_k_m',
        label: 'Q4_K_M',
        sizeBytes: 491_400_032,
        ollamaRef: `hf.co/${REPO}:Q4_K_M`,
        installedNames: [`hf.co/${REPO}:q4_k_m`.toLowerCase(), `huggingface.co/${REPO}:q4_k_m`.toLowerCase()],
        blockedReason: null,
      },
    ],
    projectorBytes: null,
    needsAccess: false,
    hubAccess: 'no-token',
    ...extra,
  };
}

interface Bridge {
  status: ModelRuntimeStatus;
  installed: InstalledModelsResult;
  search: HubSearchResult;
  detail: HubDetailResult;
  pulls: ModelPull[];
  token: HfTokenStatus;
}

let bridge: Bridge;
let pushToken: ((status: HfTokenStatus) => void) | null = null;
let pushPulls: (pulls: ModelPull[]) => void = () => {};
const calls = {
  pull: vi.fn(),
  cancelPull: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  getDetail: vi.fn(),
  getStatus: vi.fn(),
  getHfToken: vi.fn(),
  setHfToken: vi.fn(),
  clearHfToken: vi.fn(),
};

beforeEach(() => {
  pushToken = null;
  bridge = {
    status: RUNNING,
    installed: { ok: true, models: [] },
    search: { ok: true, models: [card(REPO)], nextCursor: null },
    detail: { ok: true, model: view() },
    pulls: [],
    token: { set: false, persisted: true },
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  window.localStorage.clear();
  calls.getHfToken.mockImplementation(async () => bridge.token);
  calls.pull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  calls.remove.mockResolvedValue({ ok: true });
  calls.setHfToken.mockImplementation(async () => {
    bridge.token = { ...bridge.token, set: true };
    return { ok: true, status: bridge.token };
  });
  calls.clearHfToken.mockImplementation(async () => {
    bridge.token = { ...bridge.token, set: false };
    return { ok: true, status: bridge.token };
  });
  (window as unknown as { b4m: unknown }).b4m = {
    shell: { openExternal: vi.fn() },
    models: {
      getStatus: async () => {
        calls.getStatus();
        return bridge.status;
      },
      listInstalled: async () => bridge.installed,
      search: async (request: unknown) => {
        calls.search(request);
        return bridge.search;
      },
      getDetail: async () => {
        calls.getDetail();
        return bridge.detail;
      },
      listPulls: async () => bridge.pulls,
      pull: calls.pull,
      cancelPull: calls.cancelPull,
      dismissPull: vi.fn(),
      remove: calls.remove,
      getHfToken: calls.getHfToken,
      setHfToken: calls.setHfToken,
      clearHfToken: calls.clearHfToken,
      onPullsChanged: (listener: (pulls: ModelPull[]) => void) => {
        pushPulls = listener;
        return () => {};
      },
      onHfTokenChanged: (listener: (status: HfTokenStatus) => void) => {
        pushToken = listener;
        return () => {
          pushToken = null;
        };
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

async function mount(inUse?: ModelsInUse) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelsScreen onClose={() => {}} inUse={inUse} />
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

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
    expect(q('models-remove-dialog-in-use')?.textContent).toBe('Ollama has it loaded right now.');
    await click(q('models-remove-dialog-confirm-btn'));
    expect(calls.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
  });

  it.each([
    [{ active: 'qwen2.5:0.5b', conversations: ['qwen2.5:0.5b'] }, 'The open conversation uses this model.'],
    [{ active: null, conversations: ['qwen2.5:0.5b', 'qwen2.5:0.5b', 'llama'] }, '2 conversations use this model.'],
  ])('warns before removing a model a conversation uses: %j', async (inUse, text) => {
    bridge.installed = {
      ok: true,
      models: [
        {
          name: 'qwen2.5:0.5b',
          sizeBytes: 1,
          quantization: null,
          family: null,
          parameterSize: null,
          modifiedAt: null,
          capabilities,
          loaded: false,
        },
      ],
    };
    await mount(inUse);
    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog-in-use')?.textContent).toContain(text);
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

  it('checks again on its own while Ollama looks down, and lists its models once it answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      bridge.status = { ...DOWN, error: 'timed out after 1500ms' };
      await mount();
      expect(q('models-runtime-status')?.dataset.state).toBe('down');

      bridge.status = RUNNING;
      bridge.installed = {
        ok: true,
        models: [
          {
            name: 'qwen2.5:0.5b',
            sizeBytes: 1,
            quantization: null,
            family: null,
            parameterSize: null,
            modifiedAt: null,
            capabilities,
            loaded: false,
          },
        ],
      };
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS));
      await flush();
      expect(q('models-runtime-status')?.dataset.state).toBe('running');
      expect(all('models-installed-row').map(row => row.dataset.name)).toEqual(['qwen2.5:0.5b']);

      const checks = calls.getStatus.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS * 3));
      expect(calls.getStatus.mock.calls.length).toBe(checks);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps checking after consecutive down responses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      bridge.status = DOWN;
      await mount();
      const checks = calls.getStatus.mock.calls.length;

      for (let attempt = 1; attempt <= 3; attempt++) {
        // IPC deserializes a fresh status object for each response.
        bridge.status = { ...DOWN };
        await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS));
        expect(calls.getStatus).toHaveBeenCalledTimes(checks + attempt);
        expect(q('models-runtime-status')?.dataset.state).toBe('down');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops checking when the screen closes while Ollama is down', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      bridge.status = DOWN;
      await mount();
      const checks = calls.getStatus.mock.calls.length;

      act(() => root?.unmount());
      root = null;
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS * 3));
      expect(calls.getStatus).toHaveBeenCalledTimes(checks);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ModelsScreen explore', () => {
  it.each([`hf.co/${REPO}:Q4_K_M`, `huggingface.co/${REPO}:Q4_K_M`])(
    'shows a build installed as %s as installed',
    async name => {
      bridge.installed = {
        ok: true,
        models: [
          {
            name,
            sizeBytes: 397_000_000,
            quantization: 'Q4_K_M',
            family: 'qwen2',
            parameterSize: '494M',
            modifiedAt: null,
            capabilities,
            loaded: false,
          },
        ],
      };
      await mount();
      await openExplore();
      await click(q('models-explore-result-row'));
      expect(q('models-build-installed-chip')).not.toBeNull();
    }
  );

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

  it('remembers the abliterated toggle across restarts, and keeps it off by default', async () => {
    bridge.search = {
      ok: true,
      models: [card(REPO), card('someone/Qwen2.5-7B-abliterated-GGUF', { abliterated: true })],
      nextCursor: null,
    };
    await mount();
    await openExplore();
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBeNull();
    expect(all('models-explore-result-row')).toHaveLength(1);
    await click(q('models-explore-abliterated-switch'));
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBe('1');
    await click(q('models-explore-abliterated-switch'));

    act(() => root?.unmount());
    host?.remove();
    // Turned on in an earlier run; this run's module state never saw it.
    window.localStorage.setItem('b4m.models.showAbliterated', '1');
    await mount();
    await openExplore();
    expect(all('models-explore-result-row')).toHaveLength(2);
    expect((q('models-explore-abliterated-switch') as HTMLInputElement).checked).toBe(true);
    await click(q('models-explore-abliterated-switch'));
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBe('0');
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
      revision: 'abc',
      sizeBytes: 491_400_032,
      acceptLicense: false,
      confirmAccess: false,
    });
  });

  it('names each build by its label when two share a quant', async () => {
    const plain = view().builds[0];
    bridge.detail = {
      ok: true,
      model: view({
        builds: [
          { ...plain, id: 'LFM2.5-350M-Q4_0', label: 'Q4_0' },
          { ...plain, id: 'LFM2.5-350M-QAD-Q4_0', label: 'QAD-Q4_0', ollamaRef: `hf.co/${REPO}:QAD-Q4_0` },
        ],
      }),
    };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));

    const rows = all('models-build-row');
    expect(rows.map(row => row.textContent?.includes('QAD-Q4_0'))).toEqual([false, true]);
    await click(rows[1]?.querySelector<HTMLElement>('[data-testid="models-build-pull-btn"]') ?? null);
    expect(q('models-pull-dialog')?.textContent).toContain('Download QAD-Q4_0?');
  });

  it('needs every declared license acknowledged before the download is offered', async () => {
    bridge.detail = {
      ok: true,
      model: view({
        licenses: ['apache-2.0', 'llama3'],
        licenseNames: ['apache-2.0', 'llama3'],
        licenseKind: 'restricted',
        licenseUrl: 'https://llama.meta.com/llama3/license/',
        licenseHost: 'llama.meta.com',
      }),
    };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-detail-license')?.dataset.kind).toBe('restricted');
    expect(all('models-detail-license-chip').map(chip => chip.textContent)).toEqual(['apache-2.0', 'llama3']);
    expect(q('models-detail-license-host')?.textContent).toBe('(llama.meta.com)');

    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-license-link')).not.toBeNull();
    expect(q('models-pull-dialog-license')?.textContent).toContain('(llama.meta.com)');
    expect(document.body.textContent).toContain(
      'I have read the apache-2.0 and llama3 licenses and accept their terms.'
    );
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
    expect(q('models-access-step-token')?.textContent).toContain('Add a token from that account');
    expect(q('models-access-keys-link')?.getAttribute('href')).toBe('https://huggingface.co/settings/keys');
    expect(q('models-access-steps')?.textContent).toContain('Ollama downloads with this key, not with your token.');
    expect(q('models-build-blocked-reason')?.textContent).toContain('Needs access');
    expect(q('models-build-pull-btn')).toBeNull();
  });

  it('drops the request-access step once the token can read the repo, and still asks about the Ollama key', async () => {
    bridge.token = { set: true, persisted: true };
    bridge.detail = { ok: true, model: view({ gated: 'auto', needsAccess: true, hubAccess: 'granted' }) };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-access-step-account')?.textContent).toBe('Your Hugging Face token can read it.');
    expect(q('models-access-step-token')).toBeNull();
    expect(q('models-access-repo-link')).toBeNull();

    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain(
      "I added Ollama's public key to the Hugging Face account that has access."
    );
    await click(q('models-pull-dialog-access-checkbox'));
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith(expect.objectContaining({ confirmAccess: true }));
  });

  it('says when the saved token cannot read a gated repo yet', async () => {
    bridge.token = { set: true, persisted: true };
    bridge.detail = { ok: true, model: view({ gated: 'manual', needsAccess: true, hubAccess: 'denied' }) };
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-access-step-token')?.textContent).toContain('Your saved token cannot read it yet');
    expect(q('models-access-repo-link')).not.toBeNull();
  });

  it('shows progress for a pull in flight and cancels it', async () => {
    await mount();
    act(() =>
      pushPulls([
        {
          key: `${REPO}#qwen2.5-0.5b-instruct-q4_k_m`,
          repo: REPO,
          buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
          label: 'Q4_K_M',
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
    const bars = [...document.querySelectorAll('[role="progressbar"]')];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.getAttribute('aria-label')).toBe(`Download of ${REPO} Q4_K_M`);
      expect(bar.getAttribute('aria-valuetext')).toBe('246 MB of 491 MB (50%)');
    }
  });

  it('shows a pull refused because Ollama stopped, and re-checks Ollama', async () => {
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    calls.pull.mockResolvedValue({
      ok: false,
      error: { kind: 'runtime-unavailable', message: 'Ollama is not running. Start it, then retry.' },
      listed: false,
    });
    bridge.status = DOWN;
    const checks = calls.getStatus.mock.calls.length;
    await click(q('models-build-pull-btn'));
    await click(q('models-pull-dialog-confirm-btn'));

    expect(q('models-detail-pull-error')?.textContent).toContain('Ollama is not running');
    expect(calls.getStatus.mock.calls.length).toBeGreaterThan(checks);
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
    expect(q('models-build-pull-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('re-checks Ollama when a listed pull fails', async () => {
    await mount();
    bridge.status = DOWN;
    act(() =>
      pushPulls([
        {
          key: `${REPO}#q`,
          repo: REPO,
          buildId: 'q',
          label: 'Q4_K_M',
          ref: null,
          phase: 'failed',
          completedBytes: 0,
          totalBytes: null,
          expectedBytes: 1,
          error: { kind: 'runtime-unavailable', message: 'Ollama is not running. Start it, then retry.' },
        },
      ])
    );
    await flush();
    expect(q('models-pull-status')?.textContent).toContain('Ollama is not running');
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
  });

  it('asks for a fresh review when the repo changed after the dialog', async () => {
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    const loads = calls.getDetail.mock.calls.length;
    calls.pull.mockResolvedValue({
      ok: false,
      error: { kind: 'changed', message: 'This repo changed since you reviewed it. Review it again, then download.' },
      listed: false,
    });
    await click(q('models-build-pull-btn'));
    await click(q('models-pull-dialog-confirm-btn'));
    expect(q('models-detail-pull-error')?.textContent).toContain('changed since you reviewed it');
    expect(calls.getDetail.mock.calls.length).toBe(loads + 1);
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

  it('adds a token through Hugging Face, shows a rejected one, then reloads search and the open repo', async () => {
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-hf-token')?.dataset.state).toBe('unset');
    expect(q('models-hf-token-status')?.textContent).toContain('not set');

    await click(q('models-hf-token-edit-btn'));
    expect(q('models-hf-token-dialog')).not.toBeNull();
    expect(q('models-hf-token-ollama-note')?.textContent).toContain('never sees this token');
    expect(q('models-hf-token-no-keychain')).toBeNull();
    const input = q('models-hf-token-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    type(input, 'hf_wrong');
    calls.setHfToken.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'token-rejected', message: 'Hugging Face did not accept this token.' },
    });
    await click(q('models-hf-token-save-btn'));
    expect(calls.setHfToken).toHaveBeenLastCalledWith('hf_wrong');
    expect(q('models-hf-token-error')?.textContent).toBe('Hugging Face did not accept this token.');
    expect(q('models-hf-token')?.dataset.state).toBe('unset');

    const searches = calls.search.mock.calls.length;
    const reads = calls.getDetail.mock.calls.length;
    await click(q('models-hf-token-save-btn'));
    expect(q('models-hf-token-dialog')).toBeNull();
    expect(q('models-hf-token')?.dataset.state).toBe('set');
    expect(q('models-hf-token-status')?.textContent).toBe('Hugging Face token: saved.');
    expect(calls.search.mock.calls.length).toBe(searches + 1);
    expect(calls.getDetail.mock.calls.length).toBe(reads + 1);

    await click(q('models-hf-token-remove-btn'));
    expect(calls.clearHfToken).toHaveBeenCalledTimes(1);
    expect(q('models-hf-token')?.dataset.state).toBe('unset');
    expect(calls.search.mock.calls.length).toBe(searches + 2);
  });

  it('keeps the token shown as set and says so when removing it fails', async () => {
    bridge.token = { set: true, persisted: true };
    calls.clearHfToken.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'failed', message: 'Could not remove the token. Try again.', retryAfterMs: null },
    });
    await mount();
    await openExplore();
    await click(q('models-hf-token-remove-btn'));
    expect(q('models-hf-token')?.dataset.state).toBe('set');
    expect(q('models-hf-token-remove-error')?.textContent).toBe('Could not remove the token. Try again.');
  });

  it('says a token lasts only until quit without a keychain', async () => {
    bridge.token = { set: false, persisted: false };
    await mount();
    await openExplore();
    await click(q('models-hf-token-edit-btn'));
    expect(q('models-hf-token-no-keychain')?.textContent).toContain('kept only until you quit');
    type(q('models-hf-token-input') as HTMLInputElement, 'hf_session');
    await click(q('models-hf-token-save-btn'));
    expect(q('models-hf-token-status')?.textContent).toBe('Hugging Face token: saved until you quit (no keychain).');
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

describe('Hugging Face token transport failures', () => {
  it('shows a failed status read and lets the user retry', async () => {
    await mount();
    calls.getHfToken.mockRejectedValueOnce(new Error('IPC failed'));
    await openExplore();
    await click(q('models-explore-result-row'));
    const error = q('models-hf-token-read-error');
    expect(error?.textContent).toContain('Could not read');
    const searches = calls.search.mock.calls.length;
    const details = calls.getDetail.mock.calls.length;
    await click(error?.querySelector('button') ?? null);
    expect(calls.search).toHaveBeenCalledTimes(searches + 1);
    expect(calls.getDetail.mock.calls.length).toBeGreaterThan(details);
    expect(q('models-hf-token-read-error')).toBeNull();
    expect(q('models-hf-token')).not.toBeNull();
  });

  it('keeps a pending save open and shows rejected IPC as a visible error', async () => {
    let rejectSave: (error: Error) => void = () => {};
    calls.setHfToken.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        })
    );
    await mount();
    await openExplore();
    await click(q('models-hf-token-edit-btn'));
    type(q('models-hf-token-input') as HTMLInputElement, 'hf_pending_token');
    await click(q('models-hf-token-save-btn'));
    expect((q('models-hf-token-cancel-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((q('models-hf-token-input') as HTMLInputElement).disabled).toBe(true);
    await click(q('models-hf-token-cancel-btn'));
    expect(q('models-hf-token-dialog')).not.toBeNull();
    await act(async () => {
      rejectSave(new Error('IPC failed'));
    });
    expect(q('models-hf-token-error')?.textContent).toContain('Could not save');
    expect((q('models-hf-token-cancel-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a rejected removal and keeps the saved state', async () => {
    bridge.token = { set: true, persisted: true };
    calls.clearHfToken.mockRejectedValueOnce(new Error('IPC failed'));
    await mount();
    await openExplore();
    await click(q('models-hf-token-remove-btn'));
    expect(q('models-hf-token-remove-error')?.textContent).toContain('Could not remove');
    expect(q('models-hf-token')?.dataset.state).toBe('set');
  });
});

describe('Hugging Face token changes across windows', () => {
  it('refreshes cached private results and details on a token event and unsubscribes on exit', async () => {
    await mount();
    await openExplore();
    await click(q('models-explore-result-row'));
    const searches = calls.search.mock.calls.length;
    const details = calls.getDetail.mock.calls.length;
    bridge.search = { ok: true, models: [], nextCursor: null };
    bridge.detail = { ok: false, error: { kind: 'not-found', message: 'No public repo.' } };
    await act(async () => {
      pushToken?.({ set: false, persisted: true });
    });
    await flush();
    expect(calls.search).toHaveBeenCalledTimes(searches + 1);
    expect(calls.getDetail).toHaveBeenCalledTimes(details + 1);
    expect(q('models-explore-result-row')).toBeNull();
    expect(q('models-detail-error')?.textContent).toContain('No public repo.');
    expect(q('models-hf-token')?.dataset.state).toBe('unset');
    await click(q('models-installed-tab'));
    expect(pushToken).toBeNull();
  });
});
