// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ModelServerView } from '@shared/modelServers';
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
const COMPUTER = { serverId: 'local', serverName: 'This computer', management: 'allowed' } as const;
const RUNNING: ModelRuntimeStatus = {
  reachable: true,
  version: '0.40.11',
  url: 'http://127.0.0.1:11434',
  error: null,
  ...COMPUTER,
};
const DOWN: ModelRuntimeStatus = {
  reachable: false,
  version: null,
  url: 'http://127.0.0.1:11434',
  error: 'refused',
  ...COMPUTER,
};

function server(id: string, name: string, extra: Partial<ModelServerView> = {}): ModelServerView {
  return {
    id,
    name,
    local: id === 'local',
    kind: 'ollama',
    address: id === 'local' ? 'http://127.0.0.1:11434' : `http://192.168.1.${id.length}:11434`,
    access: 'manage',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: id !== 'local',
    health: { state: 'online', version: '0.40.11', latencyMs: 3, checkedAt: null, error: null },
    models: [],
    ...extra,
  };
}

const THIS_COMPUTER = server('local', 'This computer');
const GPU_BOX = server('gpu', 'gpu box');
const SHARED_BOX = server('shared', 'shared box', { access: 'chat' });

function remoteStatus(view: ModelServerView, extra: Partial<ModelRuntimeStatus> = {}): ModelRuntimeStatus {
  return {
    reachable: true,
    version: '0.40.11',
    url: view.address,
    error: null,
    serverId: view.id,
    serverName: view.name,
    management: view.access === 'manage' ? 'allowed' : 'chat-only',
    ...extra,
  };
}
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
  /** Per saved server; this computer reads `status` and `installed`. */
  remote: Record<string, { status: ModelRuntimeStatus; installed: InstalledModelsResult }>;
  servers: ModelServerView[];
  search: HubSearchResult;
  detail: HubDetailResult;
  pulls: ModelPull[];
}

let bridge: Bridge;
let pushPulls: (pulls: ModelPull[]) => void = () => {};
const calls = {
  pull: vi.fn(),
  cancelPull: vi.fn(),
  resumePull: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  getDetail: vi.fn(),
  getStatus: vi.fn(),
  listInstalled: vi.fn(),
};

beforeEach(() => {
  bridge = {
    status: RUNNING,
    installed: { ok: true, models: [] },
    remote: {},
    servers: [THIS_COMPUTER],
    search: { ok: true, models: [card(REPO)], nextCursor: null },
    detail: { ok: true, model: view() },
    pulls: [],
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.pull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  calls.resumePull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  calls.remove.mockResolvedValue({ ok: true });
  (window as unknown as { b4m: unknown }).b4m = {
    shell: { openExternal: vi.fn() },
    modelServers: {
      list: async () => bridge.servers,
      onChanged: () => () => {},
    },
    models: {
      getStatus: async (serverId?: string) => {
        calls.getStatus(serverId);
        return (serverId && bridge.remote[serverId]?.status) || bridge.status;
      },
      listInstalled: async (serverId?: string) => {
        calls.listInstalled(serverId);
        return (serverId && bridge.remote[serverId]?.installed) || bridge.installed;
      },
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
      resumePull: calls.resumePull,
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
    expect(calls.remove).toHaveBeenCalledWith('qwen2.5:0.5b', undefined);
  });

  const onComputer = (name: string) => ({ serverId: 'local', name });
  it.each([
    [{ active: onComputer('qwen2.5:0.5b'), conversations: [onComputer('qwen2.5:0.5b')] }, 'The open conversation'],
    [
      {
        active: null,
        conversations: [
          onComputer('qwen2.5:0.5b'),
          onComputer('qwen2.5:0.5b'),
          { serverId: 'gpu', name: 'qwen2.5:0.5b' },
          onComputer('llama'),
        ],
      },
      '2 conversations use this model.',
    ],
  ])('warns before removing a model a conversation on the same server uses: %j', async (inUse, text) => {
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
      revision: 'abc',
      sizeBytes: 491_400_032,
      acceptLicense: false,
      confirmAccess: false,
    });
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
          serverId: 'local',
          serverName: 'This computer',
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
          serverId: 'local',
          serverName: 'This computer',
          repo: REPO,
          buildId: 'q',
          quant: 'Q4_K_M',
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

describe('ModelsScreen servers', () => {
  const qwen = {
    name: 'qwen2.5:0.5b',
    sizeBytes: 397_000_000,
    quantization: 'Q4_K_M',
    family: 'qwen2',
    parameterSize: '494M',
    modifiedAt: null,
    capabilities,
    loaded: false,
  };

  beforeEach(() => {
    bridge.servers = [THIS_COMPUTER, GPU_BOX, SHARED_BOX];
    bridge.remote = {
      gpu: { status: remoteStatus(GPU_BOX), installed: { ok: true, models: [qwen] } },
      shared: { status: remoteStatus(SHARED_BOX), installed: { ok: true, models: [qwen] } },
    };
  });

  // The screen remembers the server across visits, and so across tests.
  afterEach(async () => {
    if (q('models-server-select')) await pickServer('local');
  });

  async function pickServer(id: string) {
    await click(q('models-server-select'));
    await click(q(`models-server-option-${id}`));
  }

  it('offers no switcher until a model server is saved', async () => {
    bridge.servers = [THIS_COMPUTER];
    await mount();
    expect(q('models-server-select')).toBeNull();
  });

  it('lists, pulls to and removes from a server set to Chat and manage', async () => {
    await mount();
    expect(q('models-server-select')?.textContent).toContain('This computer');
    await pickServer('gpu');

    expect(calls.getStatus).toHaveBeenLastCalledWith('gpu');
    expect(calls.listInstalled).toHaveBeenLastCalledWith('gpu');
    expect(q('models-runtime-status')?.textContent).toContain('on gpu box at 192.168.1.3:11434');
    expect(q('models-installed-summary')?.textContent).toContain('on gpu box');
    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog')?.textContent).toContain('from Ollama on gpu box');
    await click(q('models-remove-dialog-confirm-btn'));
    expect(calls.remove).toHaveBeenCalledWith('qwen2.5:0.5b', 'gpu');

    await openExplore();
    await click(q('models-explore-result-row'));
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-server')?.textContent).toContain('Free space on gpu box: unknown');
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, serverId: 'gpu' }));
  });

  it('shows no pull or remove controls for a Chat only server', async () => {
    await mount();
    await pickServer('shared');

    expect(q('models-manage-note')?.textContent).toContain('shared box is set to Chat only');
    expect(all('models-installed-row')).toHaveLength(1);
    expect(q('models-installed-remove-btn')).toBeNull();
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-build-row')).not.toBeNull();
    expect(q('models-build-pull-btn')).toBeNull();
  });

  it('says which server is down and keeps the others usable', async () => {
    bridge.remote.gpu.status = remoteStatus(GPU_BOX, {
      reachable: false,
      version: null,
      error: 'Could not reach gpu box: connection refused',
    });
    await mount();
    await pickServer('gpu');
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
    expect(q('models-runtime-status')?.textContent).toContain('Could not reach gpu box: connection refused');
    expect(q('models-runtime-download-link')).toBeNull();
    expect(q('models-installed-runtime-down')?.textContent).toContain('gpu box is not reachable');

    await pickServer('local');
    expect(q('models-runtime-status')?.dataset.state).toBe('running');
  });

  it('shows a pull to a server as paused with Resume, and asks to keep the app open while it runs', async () => {
    await mount();
    const remotePull: ModelPull = {
      key: `gpu/${REPO}#q`,
      serverId: 'gpu',
      serverName: 'gpu box',
      repo: REPO,
      buildId: 'q',
      quant: 'Q4_K_M',
      ref: `hf.co/${REPO}:Q4_K_M`,
      phase: 'downloading',
      completedBytes: 100_000_000,
      totalBytes: 400_000_000,
      expectedBytes: 400_000_000,
      error: null,
    };
    act(() => pushPulls([remotePull]));
    expect(q('models-pull-row')?.textContent).toContain('to gpu box');
    expect(q('models-pull-keep-open')).not.toBeNull();
    expect(q('models-pull-resume-btn')).toBeNull();

    act(() =>
      pushPulls([
        {
          ...remotePull,
          phase: 'paused',
          error: { kind: 'connection-lost', message: 'Paused: lost the connection to gpu box.' },
        },
      ])
    );
    await flush();
    expect(q('models-pull-status')?.textContent).toBe('Paused at 100 MB of 400 MB (25%)');
    expect(q('models-pull-paused-note')?.textContent).toContain('lost the connection to gpu box');
    expect(q('models-pull-keep-open')).toBeNull();
    await click(q('models-pull-resume-btn'));
    expect(calls.resumePull).toHaveBeenCalledWith(`gpu/${REPO}#q`);
  });

  it("names the server's own Ollama key in the access steps", async () => {
    bridge.detail = { ok: true, model: view({ gated: 'auto', needsAccess: true }) };
    await mount();
    await pickServer('gpu');
    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-access-server-key')?.textContent).toContain('public key of Ollama on gpu box');
    expect(q('models-access-server-key')?.textContent).toContain('/usr/share/ollama/.ollama/id_ed25519.pub');
    await click(q('models-build-pull-btn'));
    expect(document.body.textContent).toContain('added the Ollama key of gpu box to Hugging Face');
  });
});
