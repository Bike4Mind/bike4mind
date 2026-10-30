// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ModelServerView } from '@shared/modelServers';
import {
  pullKey,
  type CuratedBuildView,
  type CuratedEntryView,
  type CuratedList,
  type CuratedPullResult,
  type HubBuildView,
  type HubDetailResult,
  type HubModelView,
  type HubSearchResult,
  type InstalledModelsResult,
  type MachineView,
  type ModelFit,
  type ModelHubError,
  type ModelPull,
  type ModelPullResult,
  type ModelRuntimeStatus,
  type HfTokenStatus,
} from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import type { ModelsInUse } from './InstalledTab';
import { ModelsScreen } from './ModelsScreen';
import { DOWN_RECHECK_MS } from './useModelHub';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIB = 1024 ** 3;

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
    specs: null,
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
        label: 'Q4_K_M',
        sizeBytes: 491_400_032,
        ollamaRef: `hf.co/${REPO}:Q4_K_M`,
        installedNames: [`hf.co/${REPO}:q4_k_m`.toLowerCase(), `huggingface.co/${REPO}:q4_k_m`.toLowerCase()],
        blockedReason: null,
        fit: null,
      },
    ],
    projectorBytes: null,
    needsAccess: false,
    hubAccess: 'no-token',
    ...extra,
  };
}

const FITS: ModelFit = {
  level: 'fits',
  basis: 'arch',
  context: 16384,
  detail: 'Fits in memory at the 16K context chat will use: about 7.4 GiB of the 46.5 GiB a model can use here.',
};
const TOO_LARGE: ModelFit = {
  level: 'too-large',
  basis: 'arch',
  context: 16384,
  detail: 'Needs about 50 GiB at the 16K context chat will use, more than the 46.5 GiB a model can use here.',
};

const GSQ = 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF';
const E4B_REF = 'gemma4:e4b-it-qat';

function curatedBuild(extra: Partial<CuratedBuildView> & Pick<CuratedBuildView, 'id'>): CuratedBuildView {
  return {
    repo: GSQ,
    pullBuildId: `Qwen3.8-27B-GSQ-RCO-${extra.id.toUpperCase().replace('-', '_')}`,
    quant: extra.id.toUpperCase().replace('-', '_'),
    sizeBytes: 9_353_988_000,
    ollamaRef: `hf.co/${GSQ}:${extra.id.toUpperCase().replace('-', '_')}`,
    fit: FITS,
    blockedReason: null,
    ...extra,
  };
}

function curatedEntry(extra: Partial<CuratedEntryView> & Pick<CuratedEntryView, 'id' | 'builds'>): CuratedEntryView {
  return {
    name: extra.id,
    why: 'On the list for its size.',
    params: '27B',
    licenseName: 'apache-2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    licenseKind: 'permissive',
    thinking: true,
    vision: true,
    code: false,
    tools: true,
    toolUse: { rating: 'unrated', note: null },
    sourceUrl: `https://huggingface.co/${GSQ}`,
    sourceName: 'Hugging Face',
    ...extra,
  };
}

const E4B = curatedBuild({
  id: 'qat-q4-0',
  repo: E4B_REF,
  pullBuildId: 'qat-q4-0',
  quant: 'Q4_0',
  sizeBytes: 6_146_501_801,
  ollamaRef: E4B_REF,
});

/** A CPU-only list whose Best pick will not fit, so Recommended sits on the Fast pick. */
function curatedList(): CuratedList {
  return {
    updatedAt: '2026-10-27T00:00:00Z',
    source: { origin: 'bundled', sequence: 1, check: 'off', checkedAt: null, stale: false },
    rating: 'probe',
    machine: { memoryKind: 'cpu', totalMemoryBytes: 62 * GIB, gpuMemoryBytes: null, gpuName: null, confidence: 'high' },
    picks: [
      { slot: 'best', entryId: 'qwen3-8-27b-gsq', buildId: 'iq3-s', recommended: false },
      { slot: 'fast', entryId: 'gemma-4-e4b', buildId: 'qat-q4-0', recommended: true },
      { slot: 'light', entryId: 'qwen3-8-27b-gsq', buildId: 'iq2-xs', recommended: false },
    ],
    entries: [
      curatedEntry({
        id: 'gemma-4-e4b',
        name: 'Gemma 4 E4B',
        params: '8B',
        sourceUrl: 'https://ollama.com/library/gemma4',
        sourceName: 'Ollama',
        builds: [E4B],
      }),
      curatedEntry({
        id: 'qwen3-8-27b-gsq',
        name: 'Qwen3.8 27B GSQ',
        builds: [curatedBuild({ id: 'iq2-xs' }), curatedBuild({ id: 'iq3-s', fit: TOO_LARGE })],
      }),
      curatedEntry({
        id: 'qwen3-8-27b',
        name: 'Qwen3.8 27B',
        sourceUrl: 'https://ollama.com/library/qwen3.8',
        sourceName: 'Ollama',
        builds: [
          curatedBuild({
            id: 'q4-k-m',
            repo: 'qwen3.8:27b',
            pullBuildId: 'q4-k-m',
            ollamaRef: 'qwen3.8:27b',
            blockedReason: 'Needs Ollama 0.32.12 or newer',
          }),
        ],
      }),
    ],
  };
}

/** What main hands back for the Gemma 4 E4B library build once its layers still match. */
function libraryPull(fit: ModelFit = FITS): CuratedPullResult {
  const build: HubBuildView = {
    id: 'qat-q4-0',
    label: 'Q4_0',
    sizeBytes: E4B.sizeBytes,
    ollamaRef: E4B_REF,
    installedNames: [E4B_REF.toLowerCase()],
    blockedReason: null,
    fit,
  };
  return {
    ok: true,
    model: view({
      id: E4B_REF,
      url: `https://ollama.com/library/${E4B_REF}`,
      revision: 'd'.repeat(64),
      licenseHost: 'ollama.com',
      builds: [build],
    }),
    build,
  };
}

interface Bridge {
  status: ModelRuntimeStatus;
  installed: InstalledModelsResult;
  /** Per saved server; this computer reads `status` and `installed`. */
  remote: Record<string, { status: ModelRuntimeStatus; installed: InstalledModelsResult; curated?: CuratedList }>;
  servers: ModelServerView[];
  search: HubSearchResult;
  detail: HubDetailResult;
  pulls: ModelPull[];
  /** Holds the next installed list, as read when asked, until it settles. */
  installedGate?: Promise<void>;
  curated: CuratedList;
  curatedFailures: number;
  curatedPull: CuratedPullResult;
  token: HfTokenStatus;
}

let bridge: Bridge;
let pushToken: ((status: HfTokenStatus) => void) | null = null;
let pushPulls: (pulls: ModelPull[]) => void = () => {};
let pushInstalled: (serverId: string) => void = () => {};
let pushServers: (servers: ModelServerView[]) => void = () => {};
let pushCuratedChanged: () => void = () => {};
const calls = {
  pull: vi.fn(),
  cancelPull: vi.fn(),
  resumePull: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  getDetail: vi.fn(),
  getStatus: vi.fn(),
  listInstalled: vi.fn(),
  getCuratedPull: vi.fn(),
  checkCurated: vi.fn(),
  listCurated: vi.fn(),
  dismissPull: vi.fn(),
  getHfToken: vi.fn(),
  setHfToken: vi.fn(),
  clearHfToken: vi.fn(),
  checkCuratedList: vi.fn(),
};

beforeEach(() => {
  pushToken = null;
  bridge = {
    status: RUNNING,
    installed: { ok: true, models: [] },
    remote: {},
    servers: [THIS_COMPUTER],
    search: { ok: true, models: [card(REPO)], nextCursor: null },
    detail: { ok: true, model: view() },
    pulls: [],
    curated: curatedList(),
    curatedFailures: 0,
    curatedPull: libraryPull(),
    token: { set: false, persisted: true },
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  window.localStorage.clear();
  calls.getHfToken.mockImplementation(async () => bridge.token);
  calls.pull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  calls.resumePull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
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
    modelServers: {
      list: async () => bridge.servers,
      onChanged: (listener: (servers: ModelServerView[]) => void) => {
        pushServers = listener;
        return () => {};
      },
    },
    models: {
      getStatus: async (serverId?: string) => {
        calls.getStatus(serverId);
        return (serverId && bridge.remote[serverId]?.status) || bridge.status;
      },
      listInstalled: async (serverId?: string) => {
        calls.listInstalled(serverId);
        const result = (serverId && bridge.remote[serverId]?.installed) || bridge.installed;
        const gate = bridge.installedGate;
        bridge.installedGate = undefined;
        await gate;
        return result;
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
      listCurated: async (serverId?: string) => {
        calls.listCurated(serverId);
        if (bridge.curatedFailures > 0) {
          bridge.curatedFailures -= 1;
          throw new Error('ipc failed');
        }
        // Main rates a saved server only from hardware entered for it.
        if (!serverId) return bridge.curated;
        return bridge.remote[serverId]?.curated ?? { ...bridge.curated, rating: null };
      },
      getCuratedPull: async (entryId: string, buildId: string, serverId?: string) => {
        calls.getCuratedPull(entryId, buildId, ...(serverId === undefined ? [] : [serverId]));
        return bridge.curatedPull;
      },
      checkCurated: (entryId: string, buildId: string, serverId?: string) =>
        calls.checkCurated(entryId, buildId, ...(serverId === undefined ? [] : [serverId])),
      checkCuratedList: async () => {
        calls.checkCuratedList();
      },
      onCuratedChanged: (listener: () => void) => {
        pushCuratedChanged = listener;
        return () => {};
      },
      pull: calls.pull,
      cancelPull: calls.cancelPull,
      resumePull: calls.resumePull,
      dismissPull: calls.dismissPull,
      remove: calls.remove,
      getHfToken: calls.getHfToken,
      setHfToken: calls.setHfToken,
      clearHfToken: calls.clearHfToken,
      onPullsChanged: (listener: (pulls: ModelPull[]) => void) => {
        pushPulls = listener;
        return () => {};
      },
      onInstalledChanged: (listener: (serverId: string) => void) => {
        pushInstalled = listener;
        return () => {};
      },
      onHfTokenChanged: (listener: (status: HfTokenStatus) => void) => {
        pushToken = listener;
        return () => {
          pushToken = null;
        };
      },
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

async function mount(inUse?: ModelsInUse, tab: 'curated' | 'installed' = 'installed') {
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
  await click(q(`models-${tab}-tab`));
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

const inside = (sectionId: string, testId: string) => [
  ...(q(sectionId)?.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`) ?? []),
];
const pickButton = (slot: string) =>
  q('models-curated-picks')?.querySelector<HTMLElement>(
    `[data-slot="${slot}"] [data-testid="models-build-pull-btn"]`
  ) ?? null;
const entryButton = (entryId: string, buildId: string) =>
  q('models-curated-all')?.querySelector<HTMLElement>(
    `[data-entry="${entryId}"] [data-testid="models-build-pull-btn"][data-build="${buildId}"]`
  ) ?? null;

describe('ModelsScreen curated', () => {
  it('opens on Curated on the first visit', async () => {
    // The remembered tab is module state, so a fresh module graph stands for a fresh app start.
    vi.resetModules();
    const [{ act: freshAct }, { createRoot: freshRoot }, { CssVarsProvider: Provider }, theme, screen] =
      await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('@mui/joy/styles'),
        import('../theme'),
        import('./ModelsScreen'),
      ]);
    const fresh = document.createElement('div');
    document.body.appendChild(fresh);
    const freshMount = freshRoot(fresh);
    await freshAct(async () => {
      freshMount.render(
        <Provider theme={theme.desktopTheme}>
          <screen.ModelsScreen onClose={() => {}} />
        </Provider>
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(q('models-curated-tab')?.getAttribute('aria-selected')).toBe('true');
    freshAct(() => freshMount.unmount());
    fresh.remove();
  });

  it('says the bundled list is shown and offers no Check now when this build cannot check', async () => {
    await mount(undefined, 'curated');
    expect(q('curated-header-status')?.textContent).toBe('Bundled with this app.');
    expect(q('curated-check-now-btn')).toBeNull();
  });

  it('shows where an updated list came from, runs Check now, and re-lists when main reports a change', async () => {
    const checkedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    bridge.curated = {
      ...curatedList(),
      source: { origin: 'updated', sequence: 3, check: 'up-to-date', checkedAt, stale: false },
    };
    await mount(undefined, 'curated');
    expect(q('curated-header-status')?.textContent).toBe('Updated online. Checked 2 h ago.');

    await click(q('curated-check-now-btn'));
    expect(calls.checkCuratedList).toHaveBeenCalledTimes(1);

    bridge.curated = {
      ...curatedList(),
      updatedAt: '2026-01-02T00:00:00Z',
      source: { origin: 'updated', sequence: 4, check: 'failed', checkedAt, stale: true },
    };
    act(() => pushCuratedChanged());
    await flush();
    expect(q('models-curated-date')?.textContent).toBe('Curated list from January 2, 2026.');
    expect(q('curated-header-status')?.textContent).toBe(
      'Updated online. Could not check for updates. This list may be out of date.'
    );
    expect(q('curated-header-status')?.dataset.check).toBe('failed');
  });

  it("shows the list's date, then this computer's picks by role, with Recommended on one", async () => {
    await mount(undefined, 'curated');
    expect(q('models-curated-date')?.textContent).toBe('Curated list from October 27, 2026.');
    expect(q('models-curated-machine')?.textContent).toContain('no GPU memory was detected');

    const picks = inside('models-curated-picks', 'models-curated-pick');
    expect(picks.map(pick => [pick.dataset.slot, pick.dataset.entry, pick.dataset.build])).toEqual([
      ['best', 'qwen3-8-27b-gsq', 'iq3-s'],
      ['fast', 'gemma-4-e4b', 'qat-q4-0'],
      ['light', 'qwen3-8-27b-gsq', 'iq2-xs'],
    ]);
    expect(inside('models-curated-picks', 'models-curated-slot-chip').map(chip => chip.textContent)).toEqual([
      'Best',
      'Fast',
      'Light',
    ]);
    const recommended = inside('models-curated-picks', 'models-curated-recommended-chip');
    expect(recommended).toHaveLength(1);
    expect(recommended[0].closest<HTMLElement>('[data-testid="models-curated-pick"]')?.dataset.slot).toBe('fast');
    expect(picks.every(pick => pick.querySelector('[data-testid="models-curated-vision-chip"]'))).toBe(true);
    expect(
      picks.map(pick => pick.querySelector<HTMLElement>('[data-testid="models-fit-badge"]')?.dataset.level)
    ).toEqual(['too-large', 'fits', 'fits']);
  });

  it('lists every model with its source, Vision badge and a fit badge per build', async () => {
    await mount(undefined, 'curated');
    const entries = inside('models-curated-all', 'models-curated-entry');
    expect(entries.map(entry => entry.dataset.entry)).toEqual(['gemma-4-e4b', 'qwen3-8-27b-gsq', 'qwen3-8-27b']);
    expect(inside('models-curated-all', 'models-curated-vision-chip')).toHaveLength(3);
    expect(
      inside('models-curated-all', 'models-curated-source-link').map(link => [
        link.textContent,
        link.getAttribute('href'),
      ])
    ).toEqual([
      ['Ollama', 'https://ollama.com/library/gemma4'],
      ['Hugging Face', `https://huggingface.co/${GSQ}`],
      ['Ollama', 'https://ollama.com/library/qwen3.8'],
    ]);
    expect(inside('models-curated-all', 'models-fit-badge').map(badge => badge.textContent)).toEqual([
      'Fits',
      'Fits',
      'Will not fit',
      'Fits',
    ]);
    expect(inside('models-curated-all', 'models-curated-quant-hint')).toHaveLength(1);
  });

  it('keeps a build that needs a newer Ollama on the list, with Download off and the reason shown', async () => {
    await mount(undefined, 'curated');
    const row = q('models-curated-all')?.querySelector<HTMLElement>(
      '[data-entry="qwen3-8-27b"] [data-testid="models-build-row"]'
    );
    expect(row?.querySelector('[data-testid="models-build-blocked-reason"]')?.textContent).toBe(
      'Needs Ollama 0.32.12 or newer'
    );
    expect(row?.querySelector('[data-testid="models-build-pull-btn"]')).toBeNull();
  });

  it('says when the list has no picks for this computer, and still lists every model', async () => {
    bridge.curated.picks = [];
    await mount(undefined, 'curated');
    expect(q('models-curated-no-picks')).not.toBeNull();
    expect(inside('models-curated-picks', 'models-curated-pick')).toHaveLength(0);
    expect(inside('models-curated-all', 'models-curated-entry')).toHaveLength(3);
  });

  it.each([
    [
      'a Mac by its total memory',
      { memoryKind: 'unified', totalMemoryBytes: 32 * GIB, gpuMemoryBytes: null, gpuName: null, confidence: 'high' },
      'This computer has 32 GiB of memory, shared with its GPU.',
    ],
    [
      'a Strix Halo by what its GPU can use, not the RAM the OS sees',
      {
        memoryKind: 'unified',
        totalMemoryBytes: 62 * GIB,
        gpuMemoryBytes: 64 * GIB,
        gpuName: 'AMD Radeon 8060S Graphics',
        confidence: 'high',
      },
      'This computer has 62 GiB of RAM, and its GPU (AMD Radeon 8060S Graphics) can use 64 GiB of memory.',
    ],
    [
      'a Strix Halo budget that could not be confirmed as a lower bound',
      { memoryKind: 'unified', totalMemoryBytes: 62 * GIB, gpuMemoryBytes: 31 * GIB, gpuName: null, confidence: 'low' },
      'This computer has 62 GiB of RAM, and its GPU can use at least 31 GiB of memory. The exact amount could not be confirmed.',
    ],
    [
      'unified memory whose GPU budget could not be measured',
      { memoryKind: 'unified', totalMemoryBytes: 62 * GIB, gpuMemoryBytes: null, gpuName: null, confidence: 'low' },
      'This computer has 62 GiB of memory, shared with its GPU. How much of it the GPU can use could not be measured.',
    ],
  ] satisfies [string, MachineView, string][])('describes %s', async (_label, machine, text) => {
    bridge.curated.machine = machine;
    await mount(undefined, 'curated');
    expect(q('models-curated-machine')?.textContent).toContain(text);
  });

  it('labels a restricted license', async () => {
    bridge.curated.entries[0] = { ...bridge.curated.entries[0], licenseName: 'other', licenseKind: 'restricted' };
    await mount(undefined, 'curated');
    const chip = inside('models-curated-all', 'models-curated-license-chip')[0];
    expect(chip?.textContent).toBe('Restricted license: other');
    expect(chip?.dataset.kind).toBe('restricted');
  });

  it('says when the list could not load, and loads it on retry', async () => {
    bridge.curatedFailures = 1;
    await mount(undefined, 'curated');
    expect(q('models-curated-load-error')?.textContent).toContain('Could not load the curated list.');
    expect(q('models-curated-loading')).toBeNull();

    await click(q('models-curated-retry-btn'));
    expect(q('models-curated-load-error')).toBeNull();
    expect(all('models-curated-entry')).toHaveLength(3);
  });

  it.each([
    [{ tools: true, toolUse: { rating: 'unrated' as const, note: null } }, 'Tools', 'has not rated'],
    [{ tools: true, toolUse: { rating: 'strong' as const, note: 'Chains calls well.' } }, 'Tools: strong', 'Chains'],
    [{ tools: false, toolUse: { rating: 'unrated' as const, note: null } }, 'No tools', 'sends it none'],
  ])('shows tool support and its rating: %j', async (change, label, tooltip) => {
    bridge.curated.entries[0] = { ...bridge.curated.entries[0], ...change };
    await mount(undefined, 'curated');
    const chip = q('models-curated-tools-chip');
    expect(chip?.textContent).toBe(label);
    // A closed describeChild tooltip leaves its text in the chip's title.
    expect(chip?.getAttribute('title')).toContain(tooltip);
  });

  it('marks a build installed only when Ollama lists its exact name', async () => {
    const installed = (name: string) => ({
      name,
      sizeBytes: 1,
      quantization: null,
      family: null,
      parameterSize: null,
      modifiedAt: null,
      capabilities,
      loaded: false,
      fit: null,
    });
    bridge.installed = {
      ok: true,
      models: [installed(E4B_REF), installed(`hf.co/${GSQ.toLowerCase()}:IQ2_XS`), installed('qwen3.8:latest')],
    };
    await mount(undefined, 'curated');
    const rows = inside('models-curated-all', 'models-build-row');
    expect(rows.map(row => row.querySelector('[data-testid="models-build-installed-chip"]') !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('checks a library pick before the dialog, then pulls the reviewed tag', async () => {
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    expect(calls.getCuratedPull).toHaveBeenCalledWith('gemma-4-e4b', 'qat-q4-0');
    expect(q('models-pull-dialog-fit')?.textContent).toContain(FITS.detail);
    expect(q('models-pull-dialog-fit-checkbox')).toBeNull();

    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith({
      repo: E4B_REF,
      buildId: 'qat-q4-0',
      revision: 'd'.repeat(64),
      sizeBytes: E4B.sizeBytes,
      acceptLicense: false,
      confirmAccess: false,
      curated: { entryId: 'gemma-4-e4b', buildId: 'qat-q4-0' },
    });
  });

  /** Main's entry for an E4B pull that failed; `ref` is null when it failed before downloading. */
  const failedE4B = (error: ModelHubError, ref: string | null = E4B_REF): ModelPull => ({
    key: pullKey(E4B_REF, E4B.id),
    serverId: 'local',
    serverName: 'This computer',
    repo: E4B_REF,
    buildId: E4B.id,
    label: E4B.quant,
    ref,
    phase: 'failed',
    completedBytes: ref ? E4B.sizeBytes : 0,
    totalBytes: ref ? E4B.sizeBytes : null,
    expectedBytes: E4B.sizeBytes,
    error,
  });

  /** Confirms the fast pick's download; main lists `failed` and resolves the pull as a listed failure. */
  async function pullFails(failed: ModelPull) {
    calls.pull.mockImplementationOnce(async () => {
      bridge.pulls = [failed];
      pushPulls(bridge.pulls);
      return { ok: false, listed: true, error: failed.error };
    });
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    await click(q('models-pull-dialog-confirm-btn'));
  }

  it('offers Check again when Ollama could not describe a finished download, and clears the alert once it passes', async () => {
    const unverified = {
      kind: 'unverified' as const,
      message: `Ollama could not describe ${E4B_REF} after downloading it.`,
    };
    const still = { kind: 'unverified' as const, message: 'Still no answer.' };
    calls.checkCurated.mockImplementationOnce(async () => {
      bridge.pulls = [failedE4B(still)];
      pushPulls(bridge.pulls);
      return { ok: false, error: still };
    });
    calls.checkCurated.mockImplementationOnce(async () => {
      bridge.pulls = [];
      pushPulls([]);
      return { ok: true };
    });
    await pullFails(failedE4B(unverified));
    expect(q('models-curated-error')?.textContent).toContain('could not describe');
    expect(q('models-curated-explore-btn')).toBeNull();

    await click(q('models-curated-check-again-btn'));
    expect(calls.checkCurated).toHaveBeenCalledWith('gemma-4-e4b', 'qat-q4-0');
    expect(q('models-curated-error')?.textContent).toContain('Still no answer.');
    expect(q('models-curated-check-again-btn')).not.toBeNull();

    await click(q('models-curated-check-again-btn'));
    expect(q('models-curated-error')).toBeNull();
  });

  it('offers no Check again for a pull refused before anything downloaded', async () => {
    await pullFails(
      failedE4B(
        { kind: 'unverified', message: 'Hugging Face could not confirm Ollama would get this exact file.' },
        null
      )
    );
    expect(q('models-curated-error')?.textContent).toContain('could not confirm');
    expect(q('models-curated-check-again-btn')).toBeNull();
  });

  it('clears the warning of a failed curated download when it is dismissed', async () => {
    const failed = failedE4B({
      kind: 'unverified',
      message: `Ollama could not describe ${E4B_REF} after downloading it.`,
    });
    calls.dismissPull.mockImplementationOnce(() => {
      bridge.pulls = [];
      pushPulls([]);
    });
    await pullFails(failed);
    expect(q('models-curated-error')).not.toBeNull();

    await click(q('models-pull-dismiss-btn'));
    expect(calls.dismissPull).toHaveBeenCalledWith(failed.key);
    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
  });

  it.each([false, true])('keeps a failed recheck dismissed (finishes after dismissal: %s)', async afterDismiss => {
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    let finish: (() => void) | undefined;
    calls.checkCurated.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () => {
            if (bridge.pulls.length > 0) {
              bridge.pulls = [failedE4B(error)];
              pushPulls(bridge.pulls);
            }
            resolve({ ok: false, error });
          };
        })
    );
    calls.dismissPull.mockImplementationOnce(() => {
      bridge.pulls = [];
      pushPulls([]);
    });
    await pullFails(failedE4B(error));
    await click(q('models-curated-check-again-btn'));
    if (!afterDismiss) await act(async () => finish?.());

    await click(q('models-pull-dismiss-btn'));
    if (afterDismiss) await act(async () => finish?.());
    await flush();

    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
    expect(q('models-curated-check-again-btn')).toBeNull();
  });

  it('clears a recheck IPC failure when its pull is dismissed', async () => {
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    calls.checkCurated.mockRejectedValueOnce(new Error('IPC unavailable'));
    calls.dismissPull.mockImplementationOnce(() => {
      bridge.pulls = [];
      pushPulls([]);
    });
    await pullFails(failedE4B(error));
    await click(q('models-curated-check-again-btn'));
    expect(q('models-curated-error')?.textContent).toContain('Could not check this model');
    await click(q('models-pull-dismiss-btn'));

    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
  });

  it('shows the check failure instead of the stored warning when the recheck IPC rejects', async () => {
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    calls.checkCurated.mockRejectedValueOnce(new Error('IPC unavailable'));
    await pullFails(failedE4B(error));
    expect(q('models-curated-error')?.textContent).toContain(error.message);

    await click(q('models-curated-check-again-btn'));
    expect(q('models-curated-error')?.textContent).toContain('Could not check this model');
    expect(q('models-curated-error')?.textContent).not.toContain(error.message);
    expect(q('models-curated-check-again-btn')).not.toBeNull();
  });

  it('keeps each row spinner while two checks are in flight', async () => {
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    const finish: Array<() => void> = [];
    calls.checkCurated.mockImplementation(
      () => new Promise(resolve => finish.push(() => resolve({ ok: false, error })))
    );
    bridge.pulls = [failedE4B(error)];
    await mount(undefined, 'curated');
    const buttons = all('models-curated-check-again-btn');
    expect(buttons.length).toBeGreaterThan(1);
    await click(buttons[0]);
    await click(buttons[1]);
    expect(all('models-curated-check-again-btn').every(button => button.hasAttribute('disabled'))).toBe(true);

    await act(async () => finish[1]());
    expect(all('models-curated-check-again-btn').some(button => button.hasAttribute('disabled'))).toBe(true);
  });

  it('reads the curated list again when the installed set changes, so a pulled Hugging Face build shows as installed', async () => {
    await mount(undefined, 'curated');
    const callsBefore = calls.listCurated.mock.calls.length;
    const resolvedRef = `hf.co/${GSQ}:IQ2_XS_RESOLVED`;
    bridge.curated = {
      ...curatedList(),
      entries: curatedList().entries.map(entry =>
        entry.id === 'qwen3-8-27b-gsq'
          ? {
              ...entry,
              builds: entry.builds.map(build => (build.id === 'iq2-xs' ? { ...build, ollamaRef: resolvedRef } : build)),
            }
          : entry
      ),
    };
    bridge.installed = {
      ok: true,
      models: [
        {
          name: resolvedRef,
          sizeBytes: 1,
          quantization: null,
          family: null,
          parameterSize: null,
          modifiedAt: null,
          capabilities,
          loaded: false,
          fit: null,
        },
      ],
    };
    expect(inside('models-curated-picks', 'models-build-installed-chip')).toHaveLength(0);
    await act(async () => pushInstalled('local'));
    await flush();

    expect(calls.listCurated.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(inside('models-curated-picks', 'models-build-installed-chip')).toHaveLength(1);
    expect(q('models-curated-loading')).toBeNull();
  });

  it('downloads nothing when the dialog is dismissed', async () => {
    await mount(undefined, 'curated');
    await click(entryButton('gemma-4-e4b', 'qat-q4-0'));
    expect(q('models-pull-dialog')).not.toBeNull();
    await click(q('models-pull-dialog-cancel-btn'));
    expect(q('models-pull-dialog')).toBeNull();
    expect(calls.pull).not.toHaveBeenCalled();
  });

  it('restores a post-pull warning and Check again after leaving the tab and screen', async () => {
    let finish: ((result: ModelPullResult) => void) | undefined;
    calls.pull.mockImplementationOnce(
      () =>
        new Promise<ModelPullResult>(resolve => {
          finish = resolve;
        })
    );
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    await click(q('models-pull-dialog-confirm-btn'));
    await click(q('models-installed-tab'));
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    bridge.pulls = [
      {
        key: pullKey(E4B_REF, E4B.id),
        serverId: 'local',
        serverName: 'This computer',
        repo: E4B_REF,
        buildId: E4B.id,
        label: E4B.quant,
        ref: E4B_REF,
        phase: 'failed',
        completedBytes: E4B.sizeBytes,
        totalBytes: E4B.sizeBytes,
        expectedBytes: E4B.sizeBytes,
        error,
      },
    ];
    await act(async () => {
      pushPulls(bridge.pulls);
      finish?.({ ok: false, error, listed: true });
    });
    expect(q('models-pull-status')?.textContent).toBe(error.message);
    act(() => root?.unmount());
    root = null;
    host?.remove();
    await mount(undefined, 'curated');
    expect(q('models-pull-status')?.textContent).toBe(error.message);
    expect(q('models-curated-check-again-btn')).not.toBeNull();
    calls.checkCurated.mockImplementationOnce(async () => {
      bridge.pulls = [];
      pushPulls([]);
      return { ok: true };
    });
    await click(q('models-curated-check-again-btn'));
    expect(calls.checkCurated).toHaveBeenCalledWith('gemma-4-e4b', E4B.id);
    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
  });

  it('shows the progress of a curated pull on its pick and its list row', async () => {
    bridge.pulls = [
      {
        key: `${E4B_REF}#qat-q4-0`,
        serverId: 'local',
        serverName: 'This computer',
        repo: E4B_REF,
        buildId: 'qat-q4-0',
        label: 'Q4_0',
        ref: E4B_REF,
        phase: 'downloading',
        completedBytes: 1_000_000_000,
        totalBytes: E4B.sizeBytes,
        expectedBytes: E4B.sizeBytes,
        error: null,
      },
    ];
    await mount(undefined, 'curated');
    expect(inside('models-curated-picks', 'models-build-progress')).toHaveLength(1);
    expect(inside('models-curated-all', 'models-build-progress')).toHaveLength(1);
  });

  it('needs an explicit override to download a build that will not fit', async () => {
    bridge.curatedPull = libraryPull(TOO_LARGE);
    await mount(undefined, 'curated');
    await click(pickButton('best'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
    await click(q('models-pull-dialog-fit-checkbox'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(false);
    await click(q('models-pull-dialog-cancel-btn'));
    expect(calls.pull).not.toHaveBeenCalled();
  });

  it('refuses a Hugging Face pick whose file changed since review, and offers Explore', async () => {
    bridge.curatedPull = {
      ok: false,
      error: { kind: 'upstream-changed', message: 'This file changed on Hugging Face since Bike4Mind reviewed it.' },
    };
    bridge.detail = { ok: true, model: view({ id: GSQ }) };
    await mount(undefined, 'curated');
    await click(pickButton('best'));
    expect(inside('models-curated-picks', 'models-curated-error')[0]?.textContent).toContain('changed on Hugging Face');
    expect(inside('models-curated-all', 'models-curated-error')).toHaveLength(0);
    expect(q('models-pull-dialog')).toBeNull();

    await click(q('models-curated-explore-btn'));
    expect(q('models-explore-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(calls.search).toHaveBeenCalledWith({ query: GSQ });
    expect(q('models-detail')?.dataset.repo).toBe(GSQ);
  });

  it.each([
    [
      'a library build that changed',
      { kind: 'upstream-changed' as const, message: `${E4B_REF} changed at its source since Bike4Mind reviewed it.` },
    ],
    ['a revision-only change', { kind: 'changed' as const, message: 'Click Download again.' }],
    ['an outage', { kind: 'hub-unreachable' as const, message: 'Hugging Face is unreachable.' }],
  ])('offers no Explore shortcut for %s', async (_label, error) => {
    bridge.curatedPull = { ok: false, error };
    await mount(undefined, 'curated');
    await click(entryButton('gemma-4-e4b', 'qat-q4-0'));
    expect(q('models-curated-error')?.textContent).toContain(error.message);
    expect(q('models-curated-explore-btn')).toBeNull();
  });

  it('clears the spinner and says so when the check itself fails', async () => {
    const models = (window as unknown as { b4m: { models: Record<string, unknown> } }).b4m.models;
    models.getCuratedPull = async () => {
      throw new Error('ipc torn down');
    };
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    expect(q('models-curated-error')?.textContent).toContain('Try again');
    expect(pickButton('fast')?.hasAttribute('disabled')).toBe(false);
  });

  it('opens the dialog only for the latest Download click', async () => {
    const pending: Array<(result: CuratedPullResult) => void> = [];
    const models = (window as unknown as { b4m: { models: Record<string, unknown> } }).b4m.models;
    models.getCuratedPull = () => new Promise<CuratedPullResult>(resolve => pending.push(resolve));
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    await click(pickButton('best'));

    await act(async () => pending[1](libraryPull(TOO_LARGE)));
    await act(async () => pending[0](libraryPull(FITS)));
    await flush();
    expect(all('models-pull-dialog')).toHaveLength(1);
    expect(q('models-pull-dialog-fit-checkbox')).not.toBeNull();
  });

  it('opens a fresh dialog, with nothing ticked, for each build', async () => {
    bridge.curatedPull = libraryPull(TOO_LARGE);
    await mount(undefined, 'curated');
    await click(pickButton('best'));
    await click(q('models-pull-dialog-fit-checkbox'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(false);

    // The other build's response replaces the open dialog, which must not keep the tick.
    await click(pickButton('light'));
    expect(all('models-pull-dialog')).toHaveLength(1);
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('refreshes availability when Ollama starts and surfaces a failed refresh until retry', async () => {
    bridge.status = DOWN;
    bridge.curated.entries[0].builds = [{ ...E4B, blockedReason: 'Ollama did not report its version' }];
    await mount(undefined, 'curated');
    expect(pickButton('fast')).toBeNull();
    bridge.status = RUNNING;
    bridge.curated = curatedList();
    bridge.curatedFailures = 1;
    await click(q('models-runtime-retry-btn'));
    expect(q('models-curated-load-error')).not.toBeNull();
    await click(q('models-curated-retry-btn'));
    expect(pickButton('fast')?.hasAttribute('disabled')).toBe(false);
    expect(q('models-build-blocked-reason')?.textContent).not.toContain('did not report');
  });

  it('says downloads need Ollama when it is not running', async () => {
    bridge.status = DOWN;
    await mount(undefined, 'curated');
    expect(q('models-curated-runtime-down')).not.toBeNull();
    expect(all('models-build-pull-btn').every(button => button.hasAttribute('disabled'))).toBe(true);
  });
});

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
          fit: FITS,
        },
      ],
    };
    await mount();
    expect(all('models-installed-row').map(row => row.dataset.name)).toEqual(['qwen2.5:0.5b']);
    expect(q('models-installed-loaded-chip')).not.toBeNull();
    expect(q('models-installed-row')?.textContent).toContain('Q4_K_M');
    expect(q('models-fit-badge')?.dataset.level).toBe('fits');
    expect(q('models-fit-badge')?.textContent).toBe('Fits');

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
          fit: null,
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
            fit: null,
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
            fit: null,
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
    bridge.detail = { ok: true, model: view({ builds: [{ ...view().builds[0], fit: FITS }] }) };
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
    expect(q('models-build-row')?.querySelector('[data-testid="models-fit-badge"]')?.textContent).toBe('Fits');

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
          key: pullKey(REPO, 'qwen2.5-0.5b-instruct-q4_k_m'),
          serverId: 'local',
          serverName: 'This computer',
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
    expect(calls.cancelPull).toHaveBeenCalledWith(pullKey(REPO, 'qwen2.5-0.5b-instruct-q4_k_m'));

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
    fit: null,
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
    expect(q('models-pull-dialog-server')?.textContent).toContain('Desktop cannot see how much free space gpu box has');
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
      label: 'Q4_K_M',
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

  const llama = { ...qwen, name: 'llama3.2:1b' };
  const rowNames = () => all('models-installed-row').map(row => row.dataset.name);

  it('reloads only the shown server models when a pull or removal on it finishes', async () => {
    await mount();
    await pickServer('gpu');
    expect(rowNames()).toEqual(['qwen2.5:0.5b']);
    bridge.remote.gpu.installed = { ok: true, models: [qwen, llama] };
    calls.getStatus.mockClear();
    calls.listInstalled.mockClear();

    act(() => pushInstalled('local'));
    await flush();
    expect(calls.listInstalled).not.toHaveBeenCalled();

    act(() => pushInstalled('gpu'));
    await flush();
    expect(calls.listInstalled.mock.calls).toEqual([['gpu']]);
    expect(calls.getStatus).not.toHaveBeenCalled();
    expect(rowNames()).toEqual(['qwen2.5:0.5b', 'llama3.2:1b']);
  });

  it('re-checks a server shown as down when a resumed pull to it finishes', async () => {
    await mount();
    await pickServer('gpu');
    const pull: ModelPull = {
      key: `gpu/${REPO}#q`,
      serverId: 'gpu',
      serverName: 'gpu box',
      repo: REPO,
      buildId: 'q',
      label: 'Q4_K_M',
      ref: `hf.co/${REPO}:Q4_K_M`,
      phase: 'paused',
      completedBytes: 100_000_000,
      totalBytes: 400_000_000,
      expectedBytes: 400_000_000,
      error: { kind: 'connection-lost', message: 'Paused: lost the connection to gpu box.' },
    };
    bridge.remote.gpu.status = remoteStatus(GPU_BOX, { reachable: false, version: null, error: 'refused' });
    act(() => pushPulls([pull]));
    await flush();
    expect(q('models-runtime-status')?.dataset.state).toBe('down');

    bridge.remote.gpu.status = remoteStatus(GPU_BOX);
    bridge.remote.gpu.installed = { ok: true, models: [qwen, llama] };
    act(() => pushPulls([{ ...pull, phase: 'downloading', error: null }]));
    act(() => pushPulls([]));
    act(() => pushInstalled('gpu'));
    await flush();
    await flush();
    expect(q('models-runtime-status')?.dataset.state).toBe('running');
    expect(rowNames()).toEqual(['qwen2.5:0.5b', 'llama3.2:1b']);
  });

  it('keeps the newer models list when an older request answers last', async () => {
    await mount();
    await pickServer('gpu');
    let release: () => void = () => {};
    bridge.installedGate = new Promise(resolve => (release = resolve));
    act(() =>
      pushPulls([
        {
          key: `gpu/${REPO}#q`,
          serverId: 'gpu',
          serverName: 'gpu box',
          repo: REPO,
          buildId: 'q',
          label: 'Q4_K_M',
          ref: null,
          phase: 'failed',
          completedBytes: 0,
          totalBytes: null,
          expectedBytes: 1,
          error: { kind: 'connection-lost', message: 'Lost the connection to gpu box.' },
        },
      ])
    );
    await flush();
    expect(calls.listInstalled).toHaveBeenLastCalledWith('gpu');

    bridge.remote.gpu.installed = { ok: true, models: [qwen, llama] };
    act(() => pushInstalled('gpu'));
    await flush();
    expect(rowNames()).toEqual(['qwen2.5:0.5b', 'llama3.2:1b']);

    release();
    await flush();
    expect(rowNames()).toEqual(['qwen2.5:0.5b', 'llama3.2:1b']);
  });

  const changeServers = async (servers: ModelServerView[]) => {
    bridge.servers = servers;
    act(() => pushServers(servers));
    await flush();
    await flush();
  };

  it.each([
    ['Chat only', { access: 'chat' }, 'chat-only'],
    ['OpenAI-compatible', { kind: 'openai-compatible' }, 'unsupported'],
  ] as const)(
    'closes both confirmations when the server becomes %s without reopening them later',
    async (_label, patch, management) => {
      await mount();
      await pickServer('gpu');
      await click(q('models-installed-remove-btn'));
      expect(q('models-remove-dialog')).not.toBeNull();

      bridge.remote.gpu.status = remoteStatus(GPU_BOX, { management });
      await changeServers([THIS_COMPUTER, { ...GPU_BOX, ...patch }, SHARED_BOX]);
      expect(q('models-remove-dialog')).toBeNull();

      bridge.remote.gpu.status = remoteStatus(GPU_BOX);
      await changeServers([THIS_COMPUTER, GPU_BOX, SHARED_BOX]);
      expect(q('models-remove-dialog')).toBeNull();
      expect(q('models-installed-remove-btn')).not.toBeNull();
      expect(calls.remove).not.toHaveBeenCalled();

      await openExplore();
      await click(q('models-explore-result-row'));
      await click(q('models-build-pull-btn'));
      expect(q('models-pull-dialog')).not.toBeNull();

      bridge.remote.gpu.status = remoteStatus(GPU_BOX, { management });
      await changeServers([THIS_COMPUTER, { ...GPU_BOX, ...patch }, SHARED_BOX]);
      expect(q('models-pull-dialog')).toBeNull();

      bridge.remote.gpu.status = remoteStatus(GPU_BOX);
      await changeServers([THIS_COMPUTER, GPU_BOX, SHARED_BOX]);
      expect(q('models-pull-dialog')).toBeNull();
      expect(q('models-build-pull-btn')).not.toBeNull();
      expect(calls.pull).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'paused'] as const)('re-checks only the selected server when a pull becomes %s', async phase => {
    await mount();
    await pickServer('gpu');
    calls.getStatus.mockClear();
    calls.listInstalled.mockClear();
    const pull: ModelPull = {
      key: `shared/${REPO}#q`,
      serverId: 'shared',
      serverName: 'shared box',
      repo: REPO,
      buildId: 'q',
      label: 'Q4_K_M',
      ref: `hf.co/${REPO}:Q4_K_M`,
      phase,
      completedBytes: 100,
      totalBytes: 400,
      expectedBytes: 400,
      error: { kind: 'connection-lost', message: 'Lost the connection.' },
    };

    act(() => pushPulls([pull]));
    await flush();
    expect(calls.getStatus).not.toHaveBeenCalled();
    expect(calls.listInstalled).not.toHaveBeenCalled();

    act(() => pushPulls([pull, { ...pull, key: `gpu/${REPO}#q`, serverId: 'gpu', serverName: 'gpu box' }]));
    await flush();
    expect(calls.getStatus.mock.calls).toEqual([['gpu']]);
    expect(calls.listInstalled.mock.calls).toEqual([['gpu']]);
  });

  it('falls back to this computer when the selected server is removed, closing its Remove confirmation', async () => {
    await mount();
    await pickServer('gpu');
    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog')?.textContent).toContain('on gpu box');

    await changeServers([THIS_COMPUTER, SHARED_BOX]);

    expect(q('models-remove-dialog')).toBeNull();
    expect(calls.getStatus).toHaveBeenLastCalledWith('local');
    expect(q('models-server-select')?.textContent).toContain('This computer');
    expect(q('models-runtime-status')?.textContent).toContain('running at');
    expect(q('models-installed-empty')?.textContent).toContain('No local models yet');
    expect(calls.remove).not.toHaveBeenCalled();
  });

  it('closes an open download dialog when its server is removed, and sends nothing', async () => {
    await mount();
    await pickServer('gpu');
    await openExplore();
    await click(q('models-explore-result-row'));
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-server')?.textContent).toContain('gpu box');

    await changeServers([THIS_COMPUTER, SHARED_BOX]);

    expect(q('models-pull-dialog-confirm-btn')).toBeNull();
    expect(calls.pull).not.toHaveBeenCalled();
  });

  it('titles the Curated picks neutrally and drops this-computer text and fit badges for a saved server', async () => {
    await mount(undefined, 'curated');
    await pickServer('local');
    expect(q('models-curated-picks')?.textContent).toContain('For this computer');
    expect(q('models-curated-machine')?.textContent).toContain('This computer has');
    expect(all('models-fit-badge').length).toBeGreaterThan(0);

    await pickServer('gpu');
    expect(q('models-curated-picks')?.textContent).toContain('Curated picks');
    expect(q('models-curated-picks')?.textContent).not.toContain('For this computer');
    expect(q('models-curated-machine')?.textContent).not.toContain('This computer');
    expect(q('models-curated-machine')?.textContent).toContain('Enter its hardware under Settings');
    expect(all('models-fit-badge')).toHaveLength(0);
  });

  it('rates a saved server from the hardware entered for it', async () => {
    bridge.remote.gpu.curated = {
      ...curatedList(),
      rating: 'entered',
      machine: {
        ...curatedList().machine,
        memoryKind: 'discrete',
        totalMemoryBytes: 64 * GIB,
        gpuMemoryBytes: 24 * GIB,
      },
    };
    await mount(undefined, 'curated');
    await pickServer('gpu');
    expect(q('models-curated-picks')?.textContent).toContain('For gpu box');
    expect(q('models-curated-machine')?.textContent).toContain(
      'gpu box is rated from the hardware entered in Settings: 64 GiB of RAM and 24 GiB of GPU memory.'
    );
    expect(all('models-fit-badge').length).toBeGreaterThan(0);
  });

  it('says when this computer is rated from entered hardware', async () => {
    bridge.curated = {
      ...curatedList(),
      rating: 'entered',
      machine: {
        ...curatedList().machine,
        memoryKind: 'unified',
        totalMemoryBytes: 128 * GIB,
        gpuMemoryBytes: 96 * GIB,
      },
    };
    await mount(undefined, 'curated');
    expect(q('models-curated-picks')?.textContent).toContain('For this computer');
    expect(q('models-curated-machine')?.textContent).toContain(
      'This computer is rated from the hardware entered in Settings: 128 GiB of memory shared with its GPU, which can use 96 GiB.'
    );
  });

  it('hides the controls and re-checks the server when Settings sets it to Chat only', async () => {
    await mount();
    await pickServer('gpu');
    expect(q('models-installed-remove-btn')).not.toBeNull();
    const checks = calls.getStatus.mock.calls.length;

    bridge.remote.gpu.status = remoteStatus(GPU_BOX, { management: 'chat-only' });
    await changeServers([THIS_COMPUTER, { ...GPU_BOX, access: 'chat' }, SHARED_BOX]);

    expect(q('models-installed-remove-btn')).toBeNull();
    expect(q('models-manage-note')?.textContent).toContain('gpu box is set to Chat only');
    expect(calls.getStatus.mock.calls.length).toBeGreaterThan(checks);
    expect(calls.getStatus).toHaveBeenLastCalledWith('gpu');
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
    expect(document.body.textContent).toContain('added the Ollama key of gpu box to the Hugging Face account');
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
