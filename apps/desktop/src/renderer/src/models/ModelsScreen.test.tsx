// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { OLLAMA_NOT_RUNNING, type ModelServerLaunchView, type ModelServerView } from '@shared/modelServers';
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
  type ModelRuntimeStatus,
  type ModelStoreLocation,
  type HfTokenStatus,
} from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { installedCache } from './installedCache';
import { FOCUS_RELOAD_MIN_MS } from '../chat/useChat';
import type { ModelsInUse } from './InstalledTab';
import { enteredText, machineText } from './CuratedTab';
import { ModelsScreen } from './ModelsScreen';
import type { ChatWith } from './modelTarget';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platform = vi.hoisted(() => ({ windows: false }));
vi.mock('../chat/platform', () => ({
  isMac: false,
  get isWindows() {
    return platform.windows;
  },
}));

// Joy's Select positions a listbox on every open, the costliest step of a server switch; this stand-in
// drives the same onChange, so the screen's handling of a switch is what these tests exercise.
vi.mock('./ServerSwitcher', () => ({
  ServerSwitcher: ({
    servers,
    value,
    onChange,
  }: {
    servers: ModelServerView[];
    value: string;
    onChange: (serverId: string) => void;
  }) => (
    <div>
      <button type="button" data-testid="models-server-select">
        {servers.find(server => server.id === value)?.name}
      </button>
      {servers.map(server => (
        <button
          key={server.id}
          type="button"
          data-testid={`models-server-option-${server.id}`}
          onClick={() => onChange(server.id)}
        >
          {server.name}
        </button>
      ))}
    </div>
  ),
}));

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
    transport: 'http',
    address: id === 'local' ? 'http://127.0.0.1:11434' : `http://192.168.1.${id.length}:11434`,
    access: 'manage',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: id !== 'local',
    health: { state: 'online', version: '0.40.11', latencyMs: 3, checkedAt: null, error: null },
    models: [],
    specs: null,
    launch: null,
    ...extra,
  };
}

function launchView(extra: Partial<ModelServerLaunchView> = {}): ModelServerLaunchView {
  return {
    runtime: 'ollama',
    owner: 'none',
    busy: null,
    settings: {},
    pendingRestart: false,
    canStart: true,
    problem: null,
    observed: null,
    sizingKvCacheType: 'f16',
    sizingFlashAttention: 'auto',
    prefill: null,
    noun: 'Ollama server',
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
        importParts: null,
        importLargestBytes: null,
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
    licenseName: 'Apache 2.0',
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
    importParts: null,
    importLargestBytes: null,
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
  /** Each holds the next detail read, answered as asked, until it settles. */
  detailGates: Promise<void>[];
  pulls: ModelPull[];
  /** Holds the next installed list, as read when asked, until it settles. */
  installedGate?: Promise<void>;
  curated: CuratedList;
  curatedFailures: number;
  curatedPull: CuratedPullResult;
  token: HfTokenStatus;
  store: ModelStoreLocation;
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
  getStoreLocation: vi.fn(),
  checkServers: vi.fn(),
  launchServer: vi.fn(),
};

function stubBridge() {
  pushToken = null;
  bridge = {
    status: RUNNING,
    installed: { ok: true, models: [] },
    remote: {},
    servers: [THIS_COMPUTER],
    search: { ok: true, models: [card(REPO)], nextCursor: null },
    detail: { ok: true, model: view() },
    detailGates: [],
    pulls: [],
    curated: curatedList(),
    curatedFailures: 0,
    curatedPull: libraryPull(),
    token: { set: false, persisted: true },
    store: { path: '/home/me/.ollama/models', source: 'runtime', freeBytes: 200 * GIB },
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  window.localStorage.clear();
  installedCache.clear();
  calls.getHfToken.mockImplementation(async () => bridge.token);
  calls.checkServers.mockImplementation(async () => bridge.servers);
  calls.launchServer.mockImplementation(async () => ({ ok: true, servers: bridge.servers }));
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
      check: calls.checkServers,
      launch: calls.launchServer,
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
        const answer = bridge.detail;
        const gate = bridge.detailGates.shift();
        if (gate) await gate;
        return answer;
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
      getStoreLocation: async (serverId?: string) => {
        calls.getStoreLocation(serverId);
        return bridge.store;
      },
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
}

beforeEach(stubBridge);

// One root and theme provider for the whole file: a fresh provider per test re-inserts the theme's global
// styles, and finding them again costs more as the document collects stylesheets. Each mount keys a new screen.
let root: Root | null = null;
let screenKey = 0;
const openModelServers = vi.fn();

function show(screen: ReactNode) {
  root ??= createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root?.render(<CssVarsProvider theme={desktopTheme}>{screen}</CssVarsProvider>));
}

/** Leaves the screen; its remembered tab and server, as module state, stay. */
const leave = () => show(null);

afterEach(() => {
  platform.windows = false;
  leave();
});

// Node's own setImmediate (untyped under the web tsconfig), held from before any test fakes
// timers: a flush then waits on neither setTimeout's 1ms floor nor a faked clock.
const { setImmediate: realSetImmediate } = globalThis as unknown as { setImmediate: (callback: () => void) => void };
const flush = () => act(async () => new Promise<void>(resolve => realSetImmediate(resolve)));

async function mount(
  inUse?: ModelsInUse,
  tab: 'curated' | 'installed' | 'explore' | null = 'installed',
  chatWith?: ChatWith,
  chatError?: { message: string; onDismiss: () => void },
  catalog?: ComponentProps<typeof ModelsScreen>['catalog'],
  onOpenServers: (() => void) | null = openModelServers
) {
  screenKey += 1;
  show(
    <ModelsScreen
      key={screenKey}
      onClose={() => {}}
      inUse={inUse}
      onOpenModelServers={onOpenServers ?? undefined}
      chatWith={chatWith}
      catalog={catalog}
      chatError={chatError?.message}
      onDismissChatError={chatError?.onDismiss}
    />
  );
  await flush();
  await flush();
  // The screen remembers its tab across visits, and so across tests.
  if (tab) await click(q(`models-${tab}-tab`));
}

const q = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
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
  // First in the file on purpose: the remembered tab is module state, so no earlier mount has picked one yet.
  it('opens on Curated on the first visit and shows the bundled list for this computer', async () => {
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
    await mount(undefined, null);
    expect(q('models-curated-tab')?.getAttribute('aria-selected')).toBe('true');

    // A bundled list, and a build that cannot check for a newer one, offers no Check now.
    expect(q('curated-header-status')?.textContent).toBe('Bundled with this app.');
    expect(q('curated-check-now-btn')).toBeNull();
    expect(q('models-curated-date')?.textContent).toBe('Curated list from October 27, 2026.');
    expect(q('models-curated-machine')?.textContent).toContain('no GPU memory was detected');

    // This computer's picks by role, with Recommended on one.
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
    expect(picks.map(pick => pick.querySelector('[data-testid="models-curated-license-chip"]')?.textContent)).toEqual([
      'Apache 2.0',
      'Apache 2.0',
      'Apache 2.0',
    ]);
    expect(
      picks.map(pick => pick.querySelector<HTMLElement>('[data-testid="models-fit-badge"]')?.dataset.level)
    ).toEqual(['too-large', 'fits', 'fits']);

    // Every model with its source, Vision badge and a fit badge per build.
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

    // A build that needs a newer Ollama stays listed, with Download off and the reason shown.
    const blocked = q('models-curated-all')?.querySelector<HTMLElement>(
      '[data-entry="qwen3-8-27b"] [data-testid="models-build-row"]'
    );
    expect(blocked?.querySelector('[data-testid="models-build-blocked-reason"]')?.textContent).toBe(
      'Needs Ollama 0.32.12 or newer'
    );
    expect(blocked?.querySelector('[data-testid="models-build-pull-btn"]')).toBeNull();

    // A pull in flight shows its progress on its pick and its list row.
    expect(inside('models-curated-picks', 'models-build-progress')).toHaveLength(1);
    expect(inside('models-curated-all', 'models-build-progress')).toHaveLength(1);
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
      'This computer has 62 GiB of memory, shared with its GPU. How much of it the GPU can use could not be determined.',
    ],
    [
      'an NVIDIA GB10 by name, with no memory figure for its GPU',
      {
        memoryKind: 'unified',
        totalMemoryBytes: 128 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'NVIDIA GB10',
        confidence: 'high',
        gpuVendor: 'nvidia',
      },
      'This computer has 128 GiB of memory, shared with its GPU (NVIDIA GB10).',
    ],
    [
      'Intel integrated graphics on Linux by name, sharing the RAM',
      {
        memoryKind: 'unified',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'Intel Lunar Lake [Intel Arc Graphics 130V / 140V]',
        confidence: 'high',
        gpuVendor: 'intel',
      },
      'This computer has 32 GiB of memory, shared with its GPU (Intel Lunar Lake [Intel Arc Graphics 130V / 140V]). Ollama does not use Intel integrated graphics, so picks and badges assume the CPU.',
    ],
    [
      'Intel integrated graphics on Windows by the half of RAM it can share',
      {
        memoryKind: 'unified',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: 16 * GIB,
        gpuName: 'Intel(R) Iris(R) Xe Graphics',
        confidence: 'high',
        gpuVendor: 'intel',
      },
      'This computer has 32 GiB of RAM, and its GPU (Intel(R) Iris(R) Xe Graphics) can use 16 GiB of memory. Ollama does not use Intel integrated graphics, so picks and badges assume the CPU.',
    ],
    [
      'an Intel card on Linux of unknown memory, with what makes it readable',
      {
        memoryKind: 'discrete',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'Intel GPU [8086:e223]',
        confidence: 'low',
        vramNeedsLlamaServer: true,
      },
      "This computer has 32 GiB of RAM and an Intel GPU [8086:e223] of unknown memory, so badges assume models run on the CPU. Linux does not report an Intel card's memory. Install a llama.cpp SYCL or Vulkan build of llama-server, with its ggml-sycl or ggml-vulkan library in the same folder, or enter its path for a llama-server model server, then save it (or restart Desktop) to read it.",
    ],
    [
      'a named Intel card on Linux of unknown memory',
      {
        memoryKind: 'discrete',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'Intel Battlemage G31 [Arc Pro B70]',
        confidence: 'low',
        vramNeedsLlamaServer: true,
      },
      'This computer has 32 GiB of RAM and an Intel Battlemage G31 [Arc Pro B70] of unknown memory, so badges',
    ],
    [
      'an Intel card named without a leading Intel',
      {
        memoryKind: 'discrete',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'NVIDIA GeForce RTX 4090 (Intel host)',
        confidence: 'low',
        vramNeedsLlamaServer: true,
      },
      'This computer has 32 GiB of RAM and an Intel GPU (NVIDIA GeForce RTX 4090 (Intel host)) of unknown memory, so badges',
    ],
    [
      'any other GPU of unknown memory as no GPU memory',
      {
        memoryKind: 'discrete',
        totalMemoryBytes: 32 * GIB,
        gpuMemoryBytes: null,
        gpuName: 'NVIDIA GPU [10de:2684]',
        confidence: 'low',
        vramNeedsLlamaServer: false,
      },
      'This computer has 32 GiB of RAM and no GPU memory was detected, so badges assume models run on the CPU.',
    ],
  ] satisfies [string, MachineView, string][])('describes %s', (_label, machine, text) => {
    expect(machineText(machine)).toContain(text);
  });

  it('describes hardware entered in Settings for this computer or a saved server', () => {
    const base = curatedList().machine;
    expect(
      enteredText(
        { ...base, memoryKind: 'unified', totalMemoryBytes: 128 * GIB, gpuMemoryBytes: 96 * GIB },
        'This computer'
      )
    ).toBe(
      'This computer is rated from the hardware entered in Settings: 128 GiB of memory shared with its GPU, which can use 96 GiB.'
    );
    expect(
      enteredText({ ...base, memoryKind: 'discrete', totalMemoryBytes: 64 * GIB, gpuMemoryBytes: 24 * GIB }, 'gpu box')
    ).toBe('gpu box is rated from the hardware entered in Settings: 64 GiB of RAM and 24 GiB of GPU memory.');
  });

  it('labels a restricted license and each kind of tool support', async () => {
    const [gemma, gsq, qwen] = bridge.curated.entries;
    bridge.curated.entries = [
      {
        ...gemma,
        licenseName: 'Gemma Terms of Use',
        licenseKind: 'restricted',
        tools: true,
        toolUse: { rating: 'strong', note: 'Chains calls well.' },
      },
      { ...gsq, tools: true, toolUse: { rating: 'unrated', note: null } },
      { ...qwen, tools: false, toolUse: { rating: 'unrated', note: null } },
    ];
    await mount(undefined, 'curated');
    const chip = inside('models-curated-all', 'models-curated-license-chip')[0];
    expect(chip?.textContent).toBe('Gemma Terms of Use (restricted)');
    // A closed describeChild tooltip leaves its text in the chip's title.
    expect(chip?.title).toBe('Gemma Terms of Use (restricted)');
    expect(chip?.tabIndex).toBe(0);
    // Only the name truncates, so "(restricted)" stays visible on a long name.
    expect(chip?.querySelector('[data-testid="models-curated-license-name"]')?.textContent).toBe('Gemma Terms of Use');
    expect(chip?.dataset.kind).toBe('restricted');
    const pick = inside('models-curated-picks', 'models-curated-pick').find(row => row.dataset.entry === 'gemma-4-e4b');
    expect(pick?.querySelector('[data-testid="models-curated-license-chip"]')?.textContent).toBe(
      'Gemma Terms of Use (restricted)'
    );

    const tools = (entryId: string) =>
      q('models-curated-all')?.querySelector<HTMLElement>(
        `[data-entry="${entryId}"] [data-testid="models-curated-tools-chip"]`
      );
    expect(
      [tools('gemma-4-e4b'), tools('qwen3-8-27b-gsq'), tools('qwen3-8-27b')].map(tool => tool?.textContent)
    ).toEqual(['Tools: strong', 'Tools', 'No tools']);
    expect(tools('gemma-4-e4b')?.getAttribute('title')).toContain('Chains');
    expect(tools('qwen3-8-27b-gsq')?.getAttribute('title')).toContain('has not rated');
    expect(tools('qwen3-8-27b')?.getAttribute('title')).toContain('sends it none');
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

  it('marks a build installed only when Ollama lists its exact name, and offers Use in chat on those', async () => {
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
    const use = vi.fn();
    const chatWith = vi.fn<ChatWith>(() => use);
    await mount(undefined, 'curated', chatWith);
    const rows = inside('models-curated-all', 'models-build-row');
    expect(rows.map(row => row.querySelector('[data-testid="models-build-installed-chip"]') !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(rows.map(row => row.querySelector('[data-testid="models-build-use-btn"]') !== null)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(chatWith).toHaveBeenCalledWith('local', E4B_REF);
    await click(rows[0].querySelector<HTMLElement>('[data-testid="models-build-use-btn"]'));
    expect(use).toHaveBeenCalledTimes(1);
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

  /** Main lists the failed pull, which owns the row's warning; dismissing it lists none. */
  async function showFailed(failed: ModelPull) {
    bridge.pulls = [failed];
    calls.dismissPull.mockImplementationOnce(() => {
      bridge.pulls = [];
      pushPulls([]);
    });
    await mount(undefined, 'curated');
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
    // Through the dialog: main lists the failure and resolves the pull as a listed failure.
    calls.pull.mockImplementationOnce(async () => {
      bridge.pulls = [failedE4B(unverified)];
      pushPulls(bridge.pulls);
      return { ok: false, listed: true, error: unverified };
    });
    await mount(undefined, 'curated');
    await click(pickButton('fast'));
    await click(q('models-pull-dialog-confirm-btn'));
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
    await showFailed(
      failedE4B(
        { kind: 'unverified', message: 'Hugging Face could not confirm Ollama would get this exact file.' },
        null
      )
    );
    expect(q('models-curated-error')?.textContent).toContain('could not confirm');
    expect(q('models-curated-check-again-btn')).toBeNull();
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
    await showFailed(failedE4B(error));
    await click(q('models-curated-check-again-btn'));
    if (!afterDismiss) await act(async () => finish?.());

    await click(q('models-pull-dismiss-btn'));
    if (afterDismiss) await act(async () => finish?.());
    await flush();

    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
    expect(q('models-curated-check-again-btn')).toBeNull();
  });

  it('shows a recheck IPC failure in place of the stored warning, until its pull is dismissed', async () => {
    const error = { kind: 'unverified' as const, message: 'Still installed; could not verify the reviewed build.' };
    calls.checkCurated.mockRejectedValueOnce(new Error('IPC unavailable'));
    await showFailed(failedE4B(error));
    expect(q('models-curated-error')?.textContent).toContain(error.message);

    await click(q('models-curated-check-again-btn'));
    expect(q('models-curated-error')?.textContent).toContain('Could not check this model');
    expect(q('models-curated-error')?.textContent).not.toContain(error.message);
    expect(q('models-curated-check-again-btn')).not.toBeNull();

    await click(q('models-pull-dismiss-btn'));
    expect(calls.dismissPull).toHaveBeenCalledWith(pullKey(E4B_REF, E4B.id));
    expect(q('models-pull-list')).toBeNull();
    expect(q('models-curated-error')).toBeNull();
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

  it('needs an explicit override to download a build that will not fit, ticked afresh for each build', async () => {
    bridge.curatedPull = libraryPull(TOO_LARGE);
    await mount(undefined, 'curated');
    await click(pickButton('best'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
    await click(q('models-pull-dialog-fit-checkbox'));
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(false);

    // The other build's response replaces the open dialog, which must not keep the tick.
    await click(pickButton('light'));
    expect(all('models-pull-dialog')).toHaveLength(1);
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(true);
    await click(q('models-pull-dialog-cancel-btn'));
    expect(q('models-pull-dialog')).toBeNull();
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

  it('offers no Explore shortcut for a library build that changed or any other refusal, and says when the check itself fails', async () => {
    const refusals: CuratedPullResult[] = [
      {
        ok: false,
        error: { kind: 'upstream-changed', message: `${E4B_REF} changed at its source since Bike4Mind reviewed it.` },
      },
      { ok: false, error: { kind: 'changed', message: 'Click Download again.' } },
    ];
    const models = (window as unknown as { b4m: { models: Record<string, unknown> } }).b4m.models;
    models.getCuratedPull = async () => {
      const next = refusals.shift();
      if (!next) throw new Error('ipc torn down');
      return next;
    };
    await mount(undefined, 'curated');
    await click(entryButton('gemma-4-e4b', 'qat-q4-0'));
    expect(q('models-curated-error')?.textContent).toContain('changed at its source');
    expect(q('models-curated-explore-btn')).toBeNull();

    await click(entryButton('gemma-4-e4b', 'qat-q4-0'));
    expect(q('models-curated-error')?.textContent).toContain('Click Download again.');
    expect(q('models-curated-explore-btn')).toBeNull();

    // The check itself failing clears the spinner and says so.
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
});

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ModelsScreen WSL GPU memory warning', () => {
  it('shows the warning main reports above the tabs', async () => {
    bridge.installed = {
      ok: true,
      models: [],
      gpuMemoryCap: { model: 'big:q8_0', sizeBytes: 36 * GIB, gpuBytes: 22 * GIB },
    };
    await mount(undefined, 'curated');
    expect(q('models-gpu-cap-warning')?.textContent).toContain('big:q8_0 loaded with 22 GiB of its 36 GiB on the GPU');
  });
});

describe('ModelsScreen installed', () => {
  it('shows the empty state and leads to Explore, with no server switcher and the last chat error', async () => {
    const onDismiss = vi.fn();
    await mount(undefined, 'installed', undefined, { message: 'Desktop could not start a conversation.', onDismiss });
    expect(q('models-runtime-status')?.dataset.state).toBe('running');
    // No model server is saved, so there is nothing to switch to.
    expect(q('models-server-select')).toBeNull();
    // Why the last Use in chat did not open a conversation, until dismissed.
    expect(q('models-chat-error')?.textContent).toContain('Desktop could not start a conversation.');
    await click(q('models-chat-error-dismiss-btn'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    expect(q('models-installed-empty')).not.toBeNull();
    await click(q('models-installed-explore-btn'));
    expect(calls.search).toHaveBeenCalled();
  });

  it('lists models with the loaded marker and Use in chat, and removes one after confirming', async () => {
    const plain = (name: string) => ({
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
        plain('nomic-embed-text:latest'),
      ],
    };
    const use = vi.fn();
    const chatWith = vi.fn<ChatWith>((_serverId, name) => (name === 'qwen2.5:0.5b' ? use : null));
    await mount(undefined, 'installed', chatWith);
    const rows = all('models-installed-row');
    expect(rows.map(row => row.dataset.name)).toEqual(['qwen2.5:0.5b', 'nomic-embed-text:latest']);
    expect(q('models-installed-loaded-chip')).not.toBeNull();
    expect(q('models-installed-row')?.textContent).toContain('Q4_K_M');
    expect(q('models-fit-badge')?.dataset.level).toBe('fits');
    expect(q('models-fit-badge')?.textContent).toBe('Fits');

    // Use in chat only on the models chat lists.
    expect(rows.map(row => row.querySelector('[data-testid="models-installed-use-btn"]') !== null)).toEqual([
      true,
      false,
    ]);
    await click(rows[0].querySelector<HTMLElement>('[data-testid="models-installed-use-btn"]'));
    expect(use).toHaveBeenCalledTimes(1);
    expect(chatWith).toHaveBeenCalledWith('local', 'qwen2.5:0.5b');

    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog')).not.toBeNull();
    expect(calls.remove).not.toHaveBeenCalled();
    expect(q('models-remove-dialog-in-use')?.textContent).toBe('Ollama has it loaded right now.');
    await click(q('models-remove-dialog-confirm-btn'));
    expect(calls.remove).toHaveBeenCalledWith('qwen2.5:0.5b', undefined);
  });

  it('warns before removing a model the open conversation uses', async () => {
    const name = 'qwen2.5:0.5b';
    bridge.installed = {
      ok: true,
      models: [
        {
          name,
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
    await mount({ active: { serverId: 'local', name }, conversations: [{ serverId: 'local', name }] });
    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog-in-use')?.textContent).toContain('The open conversation');
  });

  it('says plainly when Ollama is not running, and Explore still works without pulls', async () => {
    bridge.status = DOWN;
    await mount();
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
    expect(q('models-installed-runtime-down')?.textContent).toContain(OLLAMA_NOT_RUNNING);

    await openExplore();
    await click(q('models-explore-result-row'));
    expect(q('models-detail-runtime-down')).not.toBeNull();
    expect(q('models-build-pull-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('offers Install Ollama and Point at a server with no local runtime, and installs nothing itself', async () => {
    bridge.status = DOWN;
    openModelServers.mockReset();
    await mount(undefined, 'curated');
    expect(q('models-no-runtime-text')?.textContent).toContain('127.0.0.1:11434');
    expect(q('models-no-runtime-error')?.textContent).toBe('refused');
    // Not on Windows, so no WSL hint.
    expect(q('models-no-runtime-wsl-hint')).toBeNull();
    // Curated says downloads need Ollama, and every Download is off.
    expect(q('models-curated-runtime-down')).not.toBeNull();
    expect(all('models-build-pull-btn').every(button => button.hasAttribute('disabled'))).toBe(true);
    expect(calls.pull).not.toHaveBeenCalled();
    const openExternal = (window as unknown as { b4m: { shell: { openExternal: ReturnType<typeof vi.fn> } } }).b4m.shell
      .openExternal;
    expect(openExternal).not.toHaveBeenCalled();

    await click(q('models-install-ollama-btn'));
    expect(openExternal).toHaveBeenCalledWith('https://ollama.com/download');
    expect(calls.pull).not.toHaveBeenCalled();

    await click(q('models-point-at-server-btn'));
    expect(openModelServers).toHaveBeenCalledTimes(1);
  });

  it('offers Start in place of Install when Desktop can start Ollama, and lists models once it has', async () => {
    bridge.status = DOWN;
    bridge.servers = [{ ...THIS_COMPUTER, launch: launchView() }];
    calls.launchServer.mockImplementation(async () => {
      bridge.status = RUNNING;
      return { ok: true, servers: bridge.servers };
    });
    await mount(undefined, 'curated');
    expect(q('models-install-ollama-btn')).toBeNull();
    expect(q('models-no-runtime-text')?.textContent).not.toContain('install');
    expect(q('models-point-at-server-btn')).not.toBeNull();

    await click(q('ollama-start-btn'));
    expect(calls.launchServer).toHaveBeenCalledWith('local', 'start');
    await vi.waitFor(() => expect(q('models-runtime-status')?.dataset.state).toBe('running'));
  });

  it('shows neither Install nor Start while Desktop is still looking for Ollama', async () => {
    bridge.status = DOWN;
    bridge.servers = [{ ...THIS_COMPUTER, launch: launchView({ canStart: false, programPending: true }) }];
    await mount(undefined, 'curated');
    expect(q('ollama-start-btn')).toBeNull();
    expect(q('models-install-ollama-btn')).toBeNull();
    expect(q('ollama-start-hint')).toBeNull();
    expect(q('models-no-runtime-text')?.textContent).not.toContain('install it');
  });

  it('shows no Install button or sentence until the model server list has loaded', async () => {
    bridge.status = DOWN;
    (window as unknown as { b4m: { modelServers: { list: () => Promise<unknown> } } }).b4m.modelServers.list = () =>
      new Promise(() => {});
    await mount(undefined, 'curated');
    expect(q('models-no-runtime-text')).not.toBeNull();
    expect(q('models-no-runtime-text')?.textContent).not.toContain('install it');
    expect(q('models-install-ollama-btn')).toBeNull();
    expect(q('ollama-start-hint')).toBeNull();
  });

  it('rechecks whether Desktop can start Ollama on Check again, and offers Start once it can', async () => {
    bridge.status = DOWN;
    bridge.servers = [{ ...THIS_COMPUTER, launch: launchView({ canStart: false }) }];
    await mount(undefined, 'curated');
    expect(q('ollama-start-btn')).toBeNull();
    expect(q('ollama-start-hint')).not.toBeNull();
    expect(q('models-install-ollama-btn')).not.toBeNull();
    calls.checkServers.mockClear();
    calls.getStatus.mockClear();
    calls.checkServers.mockImplementation(async () => {
      bridge.servers = [{ ...THIS_COMPUTER, launch: launchView() }];
      act(() => pushServers(bridge.servers));
      return bridge.servers;
    });

    await click(q('models-runtime-retry-btn'));
    expect(calls.checkServers).toHaveBeenCalledWith('local');
    expect(calls.getStatus).toHaveBeenCalled();
    expect(q('ollama-start-btn')).not.toBeNull();
    expect(q('models-install-ollama-btn')).toBeNull();
  });

  it('hints at Ollama in WSL on Windows, only beside Point at a server', async () => {
    bridge.status = DOWN;
    platform.windows = true;
    await mount(undefined, 'curated');
    const hint = q('models-no-runtime-wsl-hint')?.textContent ?? '';
    expect(hint).toContain('If Ollama runs in WSL, start it there.');
    expect(hint).toContain('127.0.0.1:11434');
    expect(hint).toContain('Point at a server');
    leave();

    await mount(undefined, 'curated', undefined, undefined, undefined, null);
    expect(q('models-no-runtime-wsl-hint')).toBeNull();
  });
});

describe('ModelsScreen explore', () => {
  it('marks a build installed under the name Ollama lists it by, and offers Use in chat on it', async () => {
    bridge.installed = {
      ok: true,
      models: [
        {
          name: `hf.co/${REPO}:Q4_K_M`,
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
    const use = vi.fn();
    const chatWith = vi.fn<ChatWith>(() => use);
    await mount(undefined, 'explore', chatWith);
    await click(q('models-explore-result-row'));

    expect(q('models-build-installed-chip')).not.toBeNull();
    expect(chatWith).toHaveBeenCalledWith('local', `hf.co/${REPO}:q4_k_m`.toLowerCase());
    await click(q('models-build-use-btn'));
    expect(use).toHaveBeenCalledTimes(1);
  });

  it('hides abliterated results until the toggle is on, labels them, and remembers the toggle across restarts', async () => {
    bridge.search = {
      ok: true,
      models: [card(REPO), card('someone/Qwen2.5-7B-abliterated-GGUF', { abliterated: true })],
      nextCursor: null,
    };
    await mount(undefined, 'explore');
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBeNull();
    expect(all('models-explore-result-row').map(row => row.dataset.repo)).toEqual([REPO]);
    expect(q('models-explore-hidden-note')?.textContent).toContain('1 abliterated result is hidden');

    await click(q('models-explore-abliterated-switch'));
    expect(all('models-explore-result-row')).toHaveLength(2);
    expect(q('models-explore-abliterated-chip')).not.toBeNull();
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBe('1');
    await click(q('models-explore-abliterated-switch'));
    expect(all('models-explore-result-row')).toHaveLength(1);

    leave();
    // Turned on in an earlier run; this run's module state never saw it.
    window.localStorage.setItem('b4m.models.showAbliterated', '1');
    await mount(undefined, 'explore');
    expect(all('models-explore-result-row')).toHaveLength(2);
    expect((q('models-explore-abliterated-switch') as HTMLInputElement).checked).toBe(true);
    await click(q('models-explore-abliterated-switch'));
    expect(window.localStorage.getItem('b4m.models.showAbliterated')).toBe('0');
  });

  it('shows the license before the download button and asks before pulling', async () => {
    bridge.detail = { ok: true, model: view({ builds: [{ ...view().builds[0], fit: FITS }] }) };
    await mount(undefined, 'explore');
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
    expect(q('models-pull-dialog-path')?.dataset.state).toBe('confirmed');
    expect(q('models-pull-dialog-path')?.textContent).toBe('Saved to /home/me/.ollama/models. 214.7 GB free.');
    expect(calls.getStoreLocation).toHaveBeenCalledWith(undefined);
    await click(q('models-pull-dialog-cancel-btn'));
    expect(q('models-pull-dialog')).toBeNull();
    expect(calls.pull).not.toHaveBeenCalled();

    // Each dialog reads the model folder afresh: Ollama's default folder, short of space here.
    bridge.store = { path: '/home/me/.ollama/models', source: 'default', freeBytes: 100_000_000 };
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-path')?.dataset.state).toBe('default');
    expect(q('models-pull-dialog-path')?.textContent).toBe(
      "Saved to Ollama's model folder, /home/me/.ollama/models unless Ollama is set to use another one. 100 MB free, which is not enough for this download."
    );
    await click(q('models-pull-dialog-cancel-btn'));

    // This computer's Ollama keeps its models somewhere this disk does not have.
    bridge.store = { path: '/root/.ollama/models', source: 'elsewhere', freeBytes: null };
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-path')?.dataset.state).toBe('elsewhere');
    expect(q('models-pull-dialog-path')?.textContent).toContain('/root/.ollama/models as Ollama reports it');
    expect(q('models-pull-dialog-path')?.textContent).not.toContain('free');

    // An import that went ahead without the registry params says so.
    calls.pull.mockResolvedValue({ ok: true, ref: `hf.co/${REPO}:Q4_K_M`, notice: 'created without them.' });
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith({
      repo: REPO,
      buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
      revision: 'abc',
      sizeBytes: 491_400_032,
      acceptLicense: false,
      confirmAccess: false,
    });
    expect(q('models-detail-pull-notice')?.textContent).toBe('created without them.');
  });

  it('asks no Ollama key steps for a split build Desktop adds itself, says it comes in parts, and sizes its room as an upper bound', async () => {
    const split = {
      ...view().builds[0],
      id: 'qwen-q8_0',
      label: 'Q8_0',
      ollamaRef: `hf.co/${REPO}:Q8_0`,
      importParts: 3,
      importLargestBytes: 200_000_000,
    };
    bridge.detail = { ok: true, model: view({ builds: [split], needsAccess: true, gated: 'manual' }) };
    bridge.store = { path: '/home/me/.ollama/models', source: 'runtime', freeBytes: 600_000_000 };
    await mount(undefined, 'explore');
    await click(q('models-explore-result-row'));
    await click(q('models-build-pull-btn'));
    // Desktop makes the hard check on the parts itself, so the dialog only gives the upper bound.
    const room = q('models-pull-dialog-path')?.textContent;
    expect(room).toContain('600 MB free.');
    expect(room).not.toContain('not enough');
    expect(room).toContain('Adding the parts needs up to 691 MB free');
    expect(q('models-pull-dialog-size')?.textContent).toContain('491 MB download in 3 parts.');
    expect(q('models-pull-dialog-size')?.textContent).toContain('Desktop downloads the parts one at a time');
    expect(q('models-pull-dialog-access-checkbox')).toBeNull();
    expect(q('models-pull-dialog-confirm-btn')?.hasAttribute('disabled')).toBe(false);
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
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
    await click(q('models-explore-result-row'));
    calls.pull.mockResolvedValue({
      ok: false,
      error: { kind: 'runtime-unavailable', message: `${OLLAMA_NOT_RUNNING}. Start it, then retry.` },
      listed: false,
    });
    bridge.status = DOWN;
    const checks = calls.getStatus.mock.calls.length;
    await click(q('models-build-pull-btn'));
    await click(q('models-pull-dialog-confirm-btn'));

    expect(q('models-detail-pull-error')?.textContent).toContain(OLLAMA_NOT_RUNNING);
    expect(calls.getStatus.mock.calls.length).toBeGreaterThan(checks);
    expect(q('models-runtime-status')?.dataset.state).toBe('down');
    expect(q('models-build-pull-btn')?.hasAttribute('disabled')).toBe(true);
  });

  it('rates an open detail and its pull dialog again when main re-rates the lists', async () => {
    bridge.detail = { ok: true, model: view({ builds: [{ ...view().builds[0], fit: FITS }] }) };
    await mount(undefined, 'explore');
    await click(q('models-explore-result-row'));
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-fit-warning')).toBeNull();
    const loads = calls.getDetail.mock.calls.length;
    const warning = "Ollama 0.40.15 in WSL limits GPU memory to the WSL virtual machine's memory.";
    bridge.detail = {
      ok: true,
      model: view({ builds: [{ ...view().builds[0], fit: { ...FITS, warning } }] }),
    };
    act(() => pushCuratedChanged());
    await flush();
    expect(calls.getDetail.mock.calls.length).toBe(loads + 1);
    expect(q('models-pull-dialog-fit-warning')?.textContent).toBe(warning);
  });

  describe('re-rating while the first read is out', () => {
    const UNREACHABLE: HubDetailResult = {
      ok: false,
      error: { kind: 'hub-unreachable', message: 'Could not reach Hugging Face.' },
    };
    const gateNext = () => {
      let release: () => void = () => {};
      bridge.detailGates.push(new Promise<void>(resolve => (release = resolve)));
      return release;
    };

    it('shows the detail the first read returned when the re-rating read fails', async () => {
      await mount();
      bridge.detail = { ok: true, model: view({ id: 'first/read' }) };
      const release = gateNext();
      await openExplore();
      await click(q('models-explore-result-row'));
      bridge.detail = UNREACHABLE;
      act(() => pushCuratedChanged());
      await flush();
      release();
      await flush();
      expect(q('models-detail')?.dataset.repo).toBe('first/read');
      expect(q('models-detail-error')).toBeNull();
      expect(q('models-detail-loading')).toBeNull();
    });

    it('shows the error with Retry when both reads fail', async () => {
      await mount();
      bridge.detail = UNREACHABLE;
      const release = gateNext();
      await openExplore();
      await click(q('models-explore-result-row'));
      act(() => pushCuratedChanged());
      await flush();
      release();
      await flush();
      expect(q('models-detail-error')?.textContent).toContain('Could not reach Hugging Face.');
      expect(q('models-detail-error')?.querySelector('button')).not.toBeNull();
      expect(q('models-detail-loading')).toBeNull();
    });

    it('keeps the newer detail when an older load fails last', async () => {
      await mount();
      bridge.detail = UNREACHABLE;
      const release = gateNext();
      await openExplore();
      await click(q('models-explore-result-row'));
      bridge.detail = { ok: true, model: view({ id: 'newer/read' }) };
      act(() => pushCuratedChanged());
      await flush();
      expect(q('models-detail')?.dataset.repo).toBe('newer/read');
      release();
      await flush();
      expect(q('models-detail')?.dataset.repo).toBe('newer/read');
      expect(q('models-detail-error')).toBeNull();
    });

    it('keeps the newer read when an older load answers last', async () => {
      await mount();
      bridge.detail = { ok: true, model: view({ id: 'older/read' }) };
      const release = gateNext();
      await openExplore();
      await click(q('models-explore-result-row'));
      bridge.detail = { ok: true, model: view({ id: 'newer/read' }) };
      act(() => pushCuratedChanged());
      await flush();
      expect(q('models-detail')?.dataset.repo).toBe('newer/read');
      release();
      await flush();
      expect(q('models-detail')?.dataset.repo).toBe('newer/read');
    });
  });

  it('asks for a fresh review when the repo changed, and keeps the newest detail when an older re-rating read answers last', async () => {
    await mount(undefined, 'explore');
    await click(q('models-explore-result-row'));
    let release: () => void = () => {};
    bridge.detailGates.push(new Promise<void>(resolve => (release = resolve)));
    bridge.detail = { ok: true, model: view({ id: 'old/read' }) };
    act(() => pushCuratedChanged());
    bridge.detail = { ok: true, model: view({ id: 'new/read' }) };
    calls.pull.mockResolvedValue({
      ok: false,
      error: { kind: 'changed', message: 'This repo changed since you reviewed it. Review it again, then download.' },
      listed: false,
    });
    await click(q('models-build-pull-btn'));
    await click(q('models-pull-dialog-confirm-btn'));
    await flush();
    expect(q('models-detail-pull-error')?.textContent).toContain('changed since you reviewed it');
    expect(q('models-detail')?.dataset.repo).toBe('new/read');
    release();
    await flush();
    expect(q('models-detail')?.dataset.repo).toBe('new/read');
  });

  it('shows a failed search, with when to try again after a rate limit', async () => {
    bridge.search = { ok: false, error: { kind: 'rate-limited', message: 'x', retryAfterMs: 30_000 } };
    await mount(undefined, 'explore');
    expect(q('models-explore-error')?.textContent).toContain('Try again in 30 seconds');
  });

  it('adds a token through Hugging Face, shows a rejected one, then reloads search and the open repo', async () => {
    await mount(undefined, 'explore');
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

  it('keeps the token shown as set and says why when removing it fails or its IPC rejects', async () => {
    bridge.token = { set: true, persisted: true };
    calls.clearHfToken
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: 'failed', message: 'Hugging Face kept the token.', retryAfterMs: null },
      })
      .mockRejectedValueOnce(new Error('IPC failed'));
    await mount(undefined, 'explore');
    await click(q('models-hf-token-remove-btn'));
    expect(q('models-hf-token')?.dataset.state).toBe('set');
    expect(q('models-hf-token-remove-error')?.textContent).toBe('Hugging Face kept the token.');

    await click(q('models-hf-token-remove-btn'));
    expect(q('models-hf-token')?.dataset.state).toBe('set');
    expect(q('models-hf-token-remove-error')?.textContent).toBe('Could not remove the token. Try again.');
  });

  it('says a token lasts only until quit without a keychain', async () => {
    bridge.token = { set: false, persisted: false };
    await mount(undefined, 'explore');
    await click(q('models-hf-token-edit-btn'));
    expect(q('models-hf-token-no-keychain')?.textContent).toContain('kept only until you quit');
    type(q('models-hf-token-input') as HTMLInputElement, 'hf_session');
    await click(q('models-hf-token-save-btn'));
    expect(q('models-hf-token-status')?.textContent).toBe('Hugging Face token: saved until you quit (no keychain).');
  });

  it('says when nothing matches', async () => {
    bridge.search = { ok: true, models: [], nextCursor: null };
    await mount(undefined, 'explore');
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
    const select = q('models-server-select');
    if (select && select.textContent !== THIS_COMPUTER.name) await pickServer('local');
  });

  async function pickServer(id: string) {
    await click(q(`models-server-option-${id}`));
  }

  it('shows an SSH server by its destination', async () => {
    const lab = server('lab', 'SSH lab', { transport: 'ssh', address: 'me@gpu', unencrypted: false });
    bridge.servers = [THIS_COMPUTER, lab];
    bridge.remote.lab = { status: remoteStatus(lab, { url: 'ssh://me@gpu' }), installed: { ok: true, models: [qwen] } };
    await mount();
    await pickServer('lab');
    expect(q('models-runtime-status')?.textContent).toContain('on SSH lab at me@gpu over SSH');
    expect(q('models-runtime-status')?.textContent).not.toContain('ssh://');
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
    expect(calls.getStoreLocation).toHaveBeenLastCalledWith('gpu');
    await click(q('models-pull-dialog-confirm-btn'));
    expect(calls.pull).toHaveBeenCalledWith(expect.objectContaining({ repo: REPO, serverId: 'gpu' }));
  });

  it("names a saved server's model folder and its own Ollama key, and says so plainly when it shows no folder", async () => {
    bridge.store = { path: '/var/lib/ollama/models', source: 'runtime', freeBytes: null };
    bridge.detail = { ok: true, model: view({ gated: 'auto', needsAccess: true }) };
    await mount(undefined, 'explore');
    await pickServer('gpu');
    await click(q('models-explore-result-row'));
    expect(q('models-access-server-key')?.textContent).toContain('public key of Ollama on gpu box');
    expect(q('models-access-server-key')?.textContent).toContain('/usr/share/ollama/.ollama/id_ed25519.pub');
    await click(q('models-build-pull-btn'));
    expect(document.body.textContent).toContain('added the Ollama key of gpu box to the Hugging Face account');
    expect(q('models-pull-dialog-path')?.textContent).toBe('Saved on gpu box in /var/lib/ollama/models.');
    await click(q('models-pull-dialog-cancel-btn'));

    bridge.store = { path: null, source: null, freeBytes: null };
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog-path')?.textContent).toBe('Saved with the other models on gpu box.');
    expect(calls.pull).not.toHaveBeenCalled();
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
    expect(q('models-install-ollama-btn')).toBeNull();
    expect(q('models-point-at-server-btn')).toBeNull();
    expect(q('models-installed-runtime-down')?.textContent).toContain('gpu box is not reachable');

    await pickServer('local');
    expect(q('models-runtime-status')?.dataset.state).toBe('running');
  });

  describe('last known list', () => {
    const llama = { ...qwen, name: 'llama3.2:3b' };
    const rowNames = () => all('models-installed-row').map(row => row.textContent ?? '');

    async function visitGpuThenLeave() {
      await mount();
      await pickServer('gpu');
      expect(all('models-installed-row')).toHaveLength(1);
      await pickServer('local');
    }

    it('shows the last list at once while it refreshes, then replaces it', async () => {
      await visitGpuThenLeave();
      bridge.remote.gpu.installed = { ok: true, models: [llama, qwen] };
      let release = () => {};
      bridge.installedGate = new Promise(resolve => (release = resolve));
      act(() => q('models-server-option-gpu')?.click());

      expect(rowNames()).toHaveLength(1);
      expect(rowNames()[0]).toContain('qwen2.5:0.5b');
      expect(q('models-installed-tab')?.textContent).toBe('Installed (1)');
      expect(q('models-installed-refreshing')).not.toBeNull();
      const blocked = q('models-installed-remove-btn');
      expect(blocked?.getAttribute('aria-disabled')).toBe('true');
      expect(blocked?.hasAttribute('disabled')).toBe(false);
      act(() => blocked?.click());
      expect(q('models-remove-dialog')).toBeNull();
      const described = blocked?.getAttribute('aria-describedby');
      expect(described && document.getElementById(described)?.textContent).toBe('Available once the list refreshes');
      const reason = described ? document.getElementById(described) : null;
      expect(reason && getComputedStyle(reason).width).toBe('1px');

      await act(async () => release());
      await flush();
      expect(rowNames()).toHaveLength(2);
      expect(q('models-installed-tab')?.textContent).toBe('Installed (2)');
      expect(q('models-installed-refreshing')).toBeNull();
      expect(q('models-installed-remove-btn')?.hasAttribute('aria-disabled')).toBe(false);
    });
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

  const changeServers = async (servers: ModelServerView[]) => {
    bridge.servers = servers;
    act(() => pushServers(servers));
    await flush();
    await flush();
  };

  it('hides the controls, re-checks the server and closes both confirmations when it becomes Chat only, without reopening them later', async () => {
    await mount();
    await pickServer('gpu');
    await click(q('models-installed-remove-btn'));
    expect(q('models-remove-dialog')).not.toBeNull();
    const checks = calls.getStatus.mock.calls.length;

    bridge.remote.gpu.status = remoteStatus(GPU_BOX, { management: 'chat-only' });
    await changeServers([THIS_COMPUTER, { ...GPU_BOX, access: 'chat' }, SHARED_BOX]);
    expect(q('models-remove-dialog')).toBeNull();
    expect(q('models-installed-remove-btn')).toBeNull();
    expect(q('models-manage-note')?.textContent).toContain('gpu box is set to Chat only');
    expect(calls.getStatus.mock.calls.length).toBeGreaterThan(checks);
    expect(calls.getStatus).toHaveBeenLastCalledWith('gpu');

    bridge.remote.gpu.status = remoteStatus(GPU_BOX);
    await changeServers([THIS_COMPUTER, GPU_BOX, SHARED_BOX]);
    expect(q('models-remove-dialog')).toBeNull();
    expect(q('models-installed-remove-btn')).not.toBeNull();
    expect(calls.remove).not.toHaveBeenCalled();

    await openExplore();
    await click(q('models-explore-result-row'));
    await click(q('models-build-pull-btn'));
    expect(q('models-pull-dialog')).not.toBeNull();

    bridge.remote.gpu.status = remoteStatus(GPU_BOX, { management: 'chat-only' });
    await changeServers([THIS_COMPUTER, { ...GPU_BOX, access: 'chat' }, SHARED_BOX]);
    expect(q('models-pull-dialog')).toBeNull();

    bridge.remote.gpu.status = remoteStatus(GPU_BOX);
    await changeServers([THIS_COMPUTER, GPU_BOX, SHARED_BOX]);
    expect(q('models-pull-dialog')).toBeNull();
    expect(q('models-build-pull-btn')).not.toBeNull();
    expect(calls.pull).not.toHaveBeenCalled();
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
    bridge.remote.shared.curated = {
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

    // A saved server with hardware entered for it is rated from that.
    await pickServer('shared');
    expect(q('models-curated-picks')?.textContent).toContain('For shared box');
    expect(q('models-curated-machine')?.textContent).toContain(
      'shared box is rated from the hardware entered in Settings'
    );
    expect(all('models-fit-badge').length).toBeGreaterThan(0);
  });
});

describe('Hugging Face token transport failures', () => {
  it('shows a failed status read and lets the user retry', async () => {
    calls.getHfToken.mockRejectedValueOnce(new Error('IPC failed'));
    await mount(undefined, 'explore');
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
    await mount(undefined, 'explore');
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
});

describe('Hugging Face token changes across windows', () => {
  it('refreshes cached private results and details on a token event and unsubscribes on exit', async () => {
    await mount(undefined, 'explore');
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

describe('ModelsScreen catalog refresh', () => {
  const installedModel = (name: string, extra: Partial<typeof capabilities> = {}) => ({
    name,
    sizeBytes: 1,
    quantization: null,
    family: null,
    parameterSize: null,
    modifiedAt: null,
    capabilities: { ...capabilities, ...extra, completion: !extra.embeddings },
    loaded: false,
    fit: null,
  });
  const entry = (name: string) => ({ id: `local:ollama:${name}`, name, backend: 'ollama' });
  const busy = () => q('models-refresh-btn')?.querySelector('[role="progressbar"]') != null;

  it('reloads the catalog and the installed list from the refresh button, busy while it runs', async () => {
    let finish: () => void = () => {};
    const reload = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    await mount(undefined, 'installed', undefined, undefined, { models: [], loading: false, reload });
    reload.mockClear();
    const listed = calls.listInstalled.mock.calls.length;
    act(() => q('models-refresh-btn')?.click());
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls.listInstalled.mock.calls.length).toBe(listed + 1);
    expect(busy()).toBe(true);
    await act(async () => finish());
    await flush();
    expect(busy()).toBe(false);
  });

  it('reloads once for a chat model the catalog lacks, not again for the same set, and again for a new one', async () => {
    const reload = vi.fn(async () => {});
    bridge.installed = {
      ok: true,
      models: [installedModel('cli-pulled'), installedModel('embed', { embeddings: true })],
    };
    await mount(undefined, 'installed', undefined, undefined, { models: [entry('other')], loading: false, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    bridge.installed = { ok: true, models: [installedModel('cli-pulled')] };
    await act(async () => pushInstalled('local'));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    bridge.installed = { ok: true, models: [installedModel('cli-pulled'), installedModel('another')] };
    await act(async () => pushInstalled('local'));
    await flush();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not let a rejected reload escape the refresh button, and stops showing busy', async () => {
    const reload = vi.fn(async () => {
      throw new Error('ipc down');
    });
    await mount(undefined, 'installed', undefined, undefined, { models: [], loading: false, reload });
    reload.mockClear();
    // vitest fails the run on an unhandled rejection, so reaching the asserts is the check.
    act(() => q('models-refresh-btn')?.click());
    await flush();
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(busy()).toBe(false);
  });

  describe('on an OpenAI-compatible server', () => {
    const compatible = server('compat', 'compat box', { kind: 'openai-compatible' });
    const noFlags = { tools: false, vision: false, thinking: false, embeddings: false, completion: false };

    const reloadsFor = async (models: ReturnType<typeof installedModel>[]) => {
      bridge.servers = [THIS_COMPUTER, compatible];
      bridge.remote.compat = { status: remoteStatus(compatible), installed: { ok: true, models } };
      const reload = vi.fn(async () => {});
      await mount(undefined, 'installed', undefined, undefined, { models: [entry('other')], loading: false, reload });
      await click(q('models-server-option-compat'));
      const calls = reload.mock.calls.length;
      await click(q('models-server-option-local'));
      return calls;
    };

    it('reloads for a missing model that carries no completion flag', async () => {
      expect(await reloadsFor([{ ...installedModel('plain'), capabilities: noFlags }])).toBe(1);
    });
  });

  const rerender = async (catalog: NonNullable<ComponentProps<typeof ModelsScreen>['catalog']>) => {
    show(<ModelsScreen key={screenKey} onClose={() => {}} catalog={catalog} />);
    await flush();
    await flush();
  };

  it('waits while the catalog is loading, then reloads exactly once', async () => {
    const reload = vi.fn(async () => {});
    bridge.installed = { ok: true, models: [installedModel('cli-pulled')] };
    await mount(undefined, 'installed', undefined, undefined, { models: [], loading: true, reload });
    expect(reload).not.toHaveBeenCalled();
    await rerender({ models: [], loading: false, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    await rerender({ models: [], loading: true, reload });
    await rerender({ models: [], loading: false, reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('forgets a mismatch once the catalog lists the model, so a later one reloads again', async () => {
    const reload = vi.fn(async () => {});
    bridge.installed = { ok: true, models: [installedModel('cli-pulled')] };
    await mount(undefined, 'installed', undefined, undefined, { models: [], loading: false, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    await rerender({ models: [entry('cli-pulled')], loading: false, reload });
    await rerender({ models: [], loading: false, reload });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('refreshes the installed list on window focus at most once per throttle window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await mount();
      const listed = calls.listInstalled.mock.calls.length;
      const focus = async () => {
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        await flush();
      };
      await focus();
      expect(calls.listInstalled.mock.calls.length).toBe(listed);
      vi.setSystemTime(Date.now() + FOCUS_RELOAD_MIN_MS + 1);
      await focus();
      await focus();
      expect(calls.listInstalled.mock.calls.length).toBe(listed + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
