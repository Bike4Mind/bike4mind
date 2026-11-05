// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineView } from '@shared/models';
import type {
  ModelServerAccess,
  ModelServerKind,
  ModelServerLaunchView,
  ModelServerProbeResult,
  ModelServerView,
} from '@shared/modelServers';
import { desktopTheme } from '../theme';
import { ModelServersSettings, probedSummary } from './ModelServersSettings';

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

function saved(kind: ModelServerKind, access: ModelServerAccess): ModelServerView {
  return {
    id: 'gpu',
    name: 'gpu box',
    local: false,
    kind,
    transport: 'http',
    address: 'http://192.168.1.20:11434',
    access,
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: true,
    health: { state: 'online', version: '0.12.0', latencyMs: 12, checkedAt: null, error: null },
    models: ['qwen2.5:0.5b'],
    specs: null,
    launch: null,
  };
}

let root: Root | undefined;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
});

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};

async function type(id: string, value: string) {
  const input = element<HTMLInputElement>(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (id: string) => act(async () => element(id).click());

const health = { state: 'online' as const, version: '0.12.0', latencyMs: 4, checkedAt: null, error: null };

function server(overrides: Partial<ModelServerView>): ModelServerView {
  return {
    id: 'aaa111',
    name: 'gpu box',
    local: false,
    kind: 'ollama',
    transport: 'http',
    address: 'https://gpu.example.test',
    access: 'chat',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: false,
    health,
    models: [],
    specs: null,
    launch: null,
    ...overrides,
  };
}

function openServer(address: string, suggestedName: string): ModelServerProbeResult {
  return {
    ok: true,
    address,
    kind: 'ollama',
    version: '0.12.0',
    latencyMs: 4,
    models: 1,
    needsCredentials: false,
    unencrypted: false,
    openToAnyone: true,
    suggestedName,
    error: null,
  };
}

async function mount(servers: ModelServerView[], probe = vi.fn()) {
  const update = vi.fn(async () => ({ ok: true as const, servers }));
  (window as unknown as { b4m: unknown }).b4m = { modelServers: { probe, update } };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelServersSettings servers={servers} onServers={() => undefined} loadError={null} />
      </CssVarsProvider>
    )
  );
  return { probe, update };
}

/** Renders one saved server without replacing window.b4m, so a describe's own stubs stay in place. */
async function show(saved: ModelServerView) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelServersSettings servers={[saved]} onServers={() => undefined} loadError={null} />
      </CssVarsProvider>
    )
  );
}

describe('ModelServersSettings add form', () => {
  const checkbox = () => element<HTMLInputElement>('model-servers-add-accept-open-checkbox');
  const saveButton = () => element<HTMLButtonElement>('model-servers-add-save-btn');
  const nameInput = () => element<HTMLInputElement>('model-servers-add-name-input');

  it('asks again about an open server after the address changes, and renames it from the new test', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(openServer('https://a.example.test', 'a'))
      .mockResolvedValueOnce(openServer('https://b.example.test', 'b'));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    expect(nameInput().value).toBe('a');
    await act(async () => checkbox().click());
    expect(saveButton().disabled).toBe(false);

    await type('model-servers-add-address-input', 'https://b.example.test');
    await click('model-servers-add-test-btn');
    expect(checkbox().checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(nameInput().value).toBe('b');
  });

  it('keeps a name the user typed when the address is tested again', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(openServer('https://a.example.test', 'a'))
      .mockResolvedValueOnce(openServer('https://b.example.test', 'b'));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    await type('model-servers-add-name-input', 'my box');
    await type('model-servers-add-address-input', 'https://b.example.test');
    await click('model-servers-add-test-btn');
    expect(nameInput().value).toBe('my box');
  });

  it('ignores a test result that arrives after the address changed', async () => {
    let answer: (result: ModelServerProbeResult) => void = () => undefined;
    const probe = vi.fn(() => new Promise<ModelServerProbeResult>(resolve => (answer = resolve)));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    await type('model-servers-add-address-input', 'https://b.example.test');
    await act(async () => answer(openServer('https://a.example.test', 'a')));
    expect(document.querySelector('[data-testid="model-servers-add-name-input"]')).toBeNull();
  });

  it('saves an address on this computer that nothing answers at yet, for Desktop to start a server there', async () => {
    const probe = vi.fn(async () => ({
      ...openServer('http://127.0.0.1:8090', '127.0.0.1'),
      ok: false,
      kind: null,
      openToAnyone: false,
      error: 'Could not reach 127.0.0.1: connection refused',
      launchable: true,
    }));
    const add = vi.fn(async () => ({ ok: true as const, servers: [] }));
    await mount([], probe);
    (window as unknown as { b4m: { modelServers: Record<string, unknown> } }).b4m.modelServers.add = add;
    await type('model-servers-add-address-input', 'http://127.0.0.1:8090');
    await click('model-servers-add-test-btn');
    expect(element('model-servers-add-launchable').textContent).toContain('Nothing answers at this address yet');
    expect(document.querySelector('[data-testid="model-servers-add-result"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    await click('model-servers-add-save-btn');
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ address: 'http://127.0.0.1:8090', launch: true }));
  });
});

describe('ModelServersSettings SSH servers', () => {
  it('tests an SSH destination with no credential fields or kind choice', async () => {
    const probe = vi.fn(async () => ({ ...openServer('me@gpu', 'gpu'), openToAnyone: false }));
    await mount([], probe);
    expect(document.querySelector('[data-testid="model-servers-add-auth-select"]')).not.toBeNull();
    await click('model-servers-add-via-ssh');
    expect(document.querySelector('[data-testid="model-servers-add-auth-select"]')).toBeNull();
    await type('model-servers-add-address-input', 'me@gpu');
    await click('model-servers-add-test-btn');
    expect(probe).toHaveBeenCalledWith({ address: 'me@gpu', credential: { type: 'none' }, transport: 'ssh' });
    expect(element<HTMLInputElement>('model-servers-add-name-input').value).toBe('gpu');
    expect(document.querySelector('[data-testid="model-servers-add-kind-select"]')).toBeNull();
    expect(element<HTMLButtonElement>('model-servers-add-save-btn').disabled).toBe(false);
  });

  it('marks a saved SSH server and offers no credentials or kind change for it', async () => {
    await mount([server({ transport: 'ssh', address: 'me@gpu' })]);
    expect(element('model-servers-ssh-chip').textContent).toBe('SSH');
    expect(element('model-servers-address').textContent).toBe('me@gpu');
    expect(document.querySelector('[data-testid="model-servers-credentials-btn"]')).toBeNull();
    expect(document.querySelector('[data-testid="model-servers-kind-select"]')).toBeNull();
    expect(document.querySelector('[data-testid="model-servers-access-select"]')).not.toBeNull();
  });
});

describe('ModelServersSettings credentials form', () => {
  const saveButton = () => element<HTMLButtonElement>('model-servers-credentials-save-btn');

  it('opens on the kind of credential the server has and never saves a blank one over it', async () => {
    const { update } = await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    expect(element('model-servers-edit-auth-select').textContent).toContain('Bearer token');
    expect(saveButton().textContent).toBe('Save credentials');
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(update).not.toHaveBeenCalled();

    await type('model-servers-edit-token-input', 'tok-new');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(update).toHaveBeenCalledWith('aaa111', { credential: { type: 'bearer', token: 'tok-new' } });
  });

  it('keeps the header name of a custom header credential', async () => {
    await mount([server({ auth: { type: 'header', headerName: 'X-Api-Key' } })]);
    await click('model-servers-credentials-btn');
    expect(element<HTMLInputElement>('model-servers-edit-header-name-input').value).toBe('X-Api-Key');
    expect(saveButton().disabled).toBe(true);
  });

  it('names removing the credential as such', async () => {
    const { update } = await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    await click('model-servers-edit-auth-select');
    await click('model-servers-edit-auth-none');
    expect(saveButton().textContent).toBe('Remove credential');
    await act(async () => saveButton().click());
    expect(update).toHaveBeenCalledWith('aaa111', { credential: { type: 'none' } });
  });

  it('opens fresh from the saved credential each time', async () => {
    await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    await type('model-servers-edit-token-input', 'tok-abandoned');
    await click('model-servers-credentials-btn');
    await click('model-servers-credentials-btn');
    expect(element<HTMLInputElement>('model-servers-edit-token-input').value).toBe('');
    expect(saveButton().disabled).toBe(true);
  });

  it('offers nothing to save for a server without a credential until one is chosen', async () => {
    await mount([server({})]);
    await click('model-servers-credentials-btn');
    expect(saveButton().disabled).toBe(true);
  });
});

describe('ModelServersSettings tools hint', () => {
  const hint = 'gpu box was started without tool calling, so its chats run without tools.';
  const chip = () => document.querySelector('[data-testid="model-servers-tools-off-chip"]');
  const text = () => document.querySelector('[data-testid="model-servers-tools-hint"]')?.textContent ?? null;

  it('marks a server that refuses tools and says how to turn them on', async () => {
    await show({ ...saved('openai-compatible', 'chat'), toolsHint: hint });
    expect(chip()?.textContent).toBe('Tools off');
    expect(text()).toBe(hint);
  });

  it('says nothing while the server takes tools', async () => {
    await show(saved('openai-compatible', 'chat'));
    expect(chip()).toBeNull();
    expect(text()).toBeNull();
  });
});

describe('ModelServersSettings access note', () => {
  const note = () => document.querySelector<HTMLElement>('[data-testid="model-servers-access-note"]');
  const saved = (kind: ModelServerKind, access: ModelServerAccess) =>
    server({ kind, access, address: 'http://192.168.1.20:11434', unencrypted: true, models: ['qwen2.5:0.5b'] });

  it('points an Ollama server set to Chat and manage at the Models screen', async () => {
    await mount([saved('ollama', 'manage')]);
    expect(note()?.textContent).toMatch(/Download and remove models on this server from the Models screen/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('says only Ollama servers can be managed for an OpenAI-compatible server set to Chat and manage', async () => {
    await mount([saved('openai-compatible', 'manage')]);
    expect(note()?.textContent).toMatch(/works only on Ollama servers/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('shows no note for a server set to Chat only', async () => {
    await mount([saved('ollama', 'chat')]);
    expect(note()).toBeNull();
  });
});

describe('ModelServersSettings hardware', () => {
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const update = vi.fn(async () => ({ ok: true as const, servers: [] }));
  const probedHardware = vi.fn(async (): Promise<MachineView> => ({
    memoryKind: 'cpu',
    totalMemoryBytes: 62 * 1024 ** 3,
    gpuMemoryBytes: null,
    gpuName: null,
    confidence: 'high',
  }));

  async function type(testId: string, value: string) {
    const input = byTestId(testId) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const click = (testId: string) => act(async () => byTestId(testId)?.click());

  beforeEach(() => {
    update.mockClear();
    (window as unknown as { b4m: unknown }).b4m = { modelServers: { update, probedHardware } };
  });

  it('saves RAM, GPU memory, bandwidth and unified memory for a saved server', async () => {
    await show(saved('ollama', 'manage'));
    await click('model-servers-specs-btn');
    await type('model-servers-specs-ram-input', '128');
    await type('model-servers-specs-gpu-input', '96');
    await type('model-servers-specs-bandwidth-input', '256');
    await click('model-servers-specs-unified-checkbox');
    await click('model-servers-specs-save-btn');
    expect(update).toHaveBeenCalledWith('gpu', {
      specs: { ramGiB: 128, gpuMemoryGiB: 96, bandwidthGBps: 256, unified: true },
    });
    expect(probedHardware).not.toHaveBeenCalled();
  });

  const bandwidthLabel = () => {
    const input = byTestId('model-servers-specs-bandwidth-input') as HTMLInputElement;
    return document.querySelector(`label[for="${input.id}"]`)?.textContent;
  };

  it('asks for the GPU memory bandwidth of a saved server with a discrete GPU, not the shared memory kind', async () => {
    await show(saved('ollama', 'manage'));
    await click('model-servers-specs-btn');
    expect(bandwidthLabel()).toBe('Memory bandwidth (GB/s)');
    await type('model-servers-specs-gpu-input', '24');
    expect(bandwidthLabel()).toBe('GPU memory bandwidth (GB/s)');
    expect(byTestId('model-servers-specs-form')?.textContent).toContain("enter the GPU's own figure");
    await click('model-servers-specs-unified-checkbox');
    expect(bandwidthLabel()).toBe('Memory bandwidth (GB/s)');
    expect(byTestId('model-servers-specs-form')?.textContent).not.toContain("enter the GPU's own figure");
  });

  it.each([
    ['discrete', 'GPU memory bandwidth (GB/s)'],
    ['unified', 'Memory bandwidth (GB/s)'],
    ['cpu', 'Memory bandwidth (GB/s)'],
  ] as const)('labels the bandwidth field of this computer by what the probe found: %s', async (memoryKind, label) => {
    probedHardware.mockResolvedValueOnce({
      memoryKind,
      totalMemoryBytes: 62 * 1024 ** 3,
      gpuMemoryBytes: memoryKind === 'discrete' ? 24 * 1024 ** 3 : null,
      gpuName: null,
      confidence: 'high',
    });
    await show({ ...saved('ollama', 'manage'), id: 'local', name: 'This computer', local: true });
    await click('model-servers-specs-btn');
    expect(bandwidthLabel()).toBe(label);
  });

  it('asks for the GPU memory bandwidth of this computer only once a discrete GPU has a known memory size', async () => {
    probedHardware.mockResolvedValueOnce({
      memoryKind: 'discrete',
      totalMemoryBytes: 62 * 1024 ** 3,
      gpuMemoryBytes: null,
      gpuName: 'Test GPU',
      confidence: 'low',
    });
    await show({ ...saved('ollama', 'manage'), id: 'local', name: 'This computer', local: true });
    await click('model-servers-specs-btn');
    expect(bandwidthLabel()).toBe('Memory bandwidth (GB/s)');
    await type('model-servers-specs-gpu-input', '16');
    expect(bandwidthLabel()).toBe('GPU memory bandwidth (GB/s)');
  });

  it('asks for RAM before saving GPU memory for a saved server', async () => {
    await show(saved('ollama', 'manage'));
    await click('model-servers-specs-btn');
    await type('model-servers-specs-gpu-input', '24');
    await click('model-servers-specs-save-btn');
    expect(byTestId('model-servers-specs-error')?.textContent).toContain('Enter the RAM too');
    expect(update).not.toHaveBeenCalled();
  });

  it('shows what was entered and lets it be cleared', async () => {
    await show({
      ...saved('ollama', 'manage'),
      specs: { ramGiB: 64, gpuMemoryGiB: 24, bandwidthGBps: null, unified: false },
    });
    expect(byTestId('model-servers-specs-summary')?.textContent).toBe('Hardware entered: 64 GB RAM, 24 GB GPU memory.');
    await click('model-servers-specs-btn');
    expect((byTestId('model-servers-specs-ram-input') as HTMLInputElement).value).toBe('64');
    await click('model-servers-specs-clear-btn');
    expect(update).toHaveBeenCalledWith('gpu', { specs: null });
  });

  it('shows this computer what the probe found beside the fields, with no unified memory choice', async () => {
    await show({ ...saved('ollama', 'manage'), id: 'local', name: 'This computer', local: true });
    await click('model-servers-specs-btn');
    expect(byTestId('model-servers-specs-probed')?.textContent).toBe('Detected: 62 GiB of RAM and no GPU memory.');
    expect((byTestId('model-servers-specs-ram-input') as HTMLInputElement).placeholder).toBe('62');
    expect(byTestId('model-servers-specs-unified-checkbox')).toBeNull();
    await type('model-servers-specs-gpu-input', '16');
    await click('model-servers-specs-save-btn');
    expect(update).toHaveBeenCalledWith('local', {
      specs: { ramGiB: null, gpuMemoryGiB: 16, bandwidthGBps: null, unified: false },
    });
  });

  it('asks for no KV cache type with the hardware', async () => {
    await show({ ...saved('ollama', 'manage'), id: 'local', name: 'This computer', local: true });
    await click('model-servers-specs-btn');
    expect(byTestId('model-servers-specs-form')).not.toBeNull();
    expect(byTestId('model-servers-specs-form')?.textContent).not.toContain('KV cache');
  });

  const launchOf = (owner: 'remote' | 'none') => ({
    runtime: 'ollama' as const,
    owner,
    busy: null,
    settings: {},
    pendingRestart: false,
    canStart: false,
    problem: null,
    observed: null,
    sizingKvCacheType: 'f16' as const,
    sizingFlashAttention: 'auto' as const,
    prefill: null,
    noun: 'Ollama server',
  });

  it('asks a remote Ollama for the KV cache type it runs with, which Desktop cannot set', async () => {
    await show({ ...saved('ollama', 'manage'), launch: launchOf('remote') });
    await click('model-servers-specs-btn');
    await type('model-servers-specs-ram-input', '64');
    await click('model-servers-specs-kv-select');
    await click('model-servers-specs-kv-option-q8_0');
    await click('model-servers-specs-save-btn');
    expect(update).toHaveBeenCalledWith('gpu', {
      specs: { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false, kvCacheType: 'q8_0' },
    });
  });

  it('leaves the KV cache type of a server Desktop can start to its launch settings', async () => {
    await show({ ...saved('ollama', 'manage'), address: 'http://127.0.0.1:11500', launch: launchOf('none') });
    await click('model-servers-specs-btn');
    expect(byTestId('model-servers-specs-kv-select')).toBeNull();
  });
});

describe('ModelServersSettings launch settings', () => {
  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const update = vi.fn(async () => ({ ok: true as const, servers: [] }));
  const launchAction = vi.fn(async () => ({ ok: true as const, servers: [] }));
  const clickId = (testId: string) => act(async () => byTestId(testId)?.click());
  const LOCAL = { ...saved('ollama', 'manage'), id: 'local', name: 'This computer', local: true };

  function launch(over: Partial<ModelServerLaunchView> = {}): ModelServerLaunchView {
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
      ...over,
    };
  }

  beforeEach(() => {
    update.mockClear();
    launchAction.mockClear();
    (window as unknown as { b4m: unknown }).b4m = { modelServers: { update, launch: launchAction } };
  });

  it('starts an Ollama nothing runs, and saves its KV cache type and flash attention', async () => {
    await show({ ...LOCAL, launch: launch() });
    expect(byTestId('model-servers-launch-owner')?.textContent).toBe('Not running');
    expect(byTestId('model-servers-launch-locked')).toBeNull();
    await clickId('model-servers-launch-start-btn');
    expect(launchAction).toHaveBeenCalledWith('local', 'start');
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-models-dir-input')).toBeNull();
    await clickId('model-servers-launch-kv-select');
    await clickId('model-servers-launch-kv-option-q8_0');
    await clickId('model-servers-launch-save-btn');
    expect(update).toHaveBeenLastCalledWith('local', { launch: { kvCacheType: 'q8_0' } });
  });

  it('refuses a quantized cache with flash attention off before saving', async () => {
    await show({ ...LOCAL, launch: launch() });
    await clickId('model-servers-launch-settings-btn');
    await clickId('model-servers-launch-kv-select');
    await clickId('model-servers-launch-kv-option-q4_0');
    await clickId('model-servers-launch-flash-select');
    await clickId('model-servers-launch-flash-option-off');
    await clickId('model-servers-launch-save-btn');
    expect(byTestId('model-servers-launch-error')?.textContent).toContain('needs flash attention');
    expect(update).not.toHaveBeenCalled();
  });

  it('offers Restart to apply and Stop for the server Desktop started', async () => {
    await show({
      ...LOCAL,
      launch: launch({ owner: 'desktop', canStart: false, pendingRestart: true, settings: { kvCacheType: 'q4_0' } }),
    });
    expect(byTestId('model-servers-launch-owner')?.textContent).toBe('Started by Desktop');
    expect(byTestId('model-servers-launch-start-btn')).toBeNull();
    expect(byTestId('model-servers-launch-pending')).not.toBeNull();
    expect(byTestId('model-servers-launch-restart-btn')?.textContent).toBe('Restart to apply');
    await clickId('model-servers-launch-restart-btn');
    await clickId('model-servers-launch-stop-btn');
    expect(launchAction.mock.calls).toEqual([
      ['local', 'restart'],
      ['local', 'stop'],
    ]);
  });

  it('disables the settings of an Ollama Desktop did not start, says so, and shows what it runs with', async () => {
    await show({
      ...LOCAL,
      launch: launch({
        owner: 'other',
        canStart: false,
        settings: { kvCacheType: 'q8_0' },
        observed: { OLLAMA_KV_CACHE_TYPE: 'q8_0' },
        sizingKvCacheType: 'q8_0',
      }),
    });
    expect(byTestId('model-servers-launch-owner')?.textContent).toBe('Not started by Desktop');
    expect(byTestId('model-servers-launch-locked')?.textContent).toBe(
      "This Ollama server was not started by Bike4Mind Desktop, so Desktop can't apply these settings. To use them, stop that server and start it from Desktop."
    );
    expect(byTestId('model-servers-launch-observed')?.textContent).toBe(
      'It runs with OLLAMA_KV_CACHE_TYPE=q8_0. Fit badges assume a q8_0 KV cache.'
    );
    expect(byTestId('model-servers-launch-start-btn')).toBeNull();
    expect(byTestId('model-servers-launch-stop-btn')).toBeNull();
    await clickId('model-servers-launch-settings-btn');
    expect((byTestId('model-servers-launch-save-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('model-servers-launch-kv-select')?.hasAttribute('disabled')).toBe(true);
  });

  it('fills the form in from the Ollama that ran here while nothing is saved, and saves it', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ prefill }) });
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-prefilled')?.textContent).toBe(
      'Filled in from the Ollama that ran here: OLLAMA_KV_CACHE_TYPE=q8_0. Start uses these.'
    );
    expect(byTestId('model-servers-launch-kv-select')?.textContent).toContain('q8_0');
    await clickId('model-servers-launch-save-btn');
    expect(update).toHaveBeenLastCalledWith('local', { launch: { kvCacheType: 'q8_0' } });
  });

  it('saves the prefilled values before Start, so the server starts with what the form shows', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ prefill }) });
    await clickId('model-servers-launch-start-btn');
    expect(update).toHaveBeenCalledWith('local', { launch: { kvCacheType: 'q8_0' } });
    expect(launchAction).toHaveBeenCalledWith('local', 'start');
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(launchAction.mock.invocationCallOrder[0]);
  });

  it('stays idle when saving the prefilled values fails', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ prefill }) });
    update.mockResolvedValueOnce({ ok: false, error: 'could not save' } as never);
    await clickId('model-servers-launch-start-btn');
    expect(update).toHaveBeenCalledTimes(1);
    expect(launchAction).not.toHaveBeenCalled();
  });

  it('starts without saving when launch settings are already saved', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ prefill, settings: { flashAttention: 'on' } }) });
    await clickId('model-servers-launch-start-btn');
    expect(update).not.toHaveBeenCalled();
    expect(launchAction).toHaveBeenCalledWith('local', 'start');
  });

  it('says a prefill needs a restart while the server Desktop started runs', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ owner: 'desktop', canStart: false, prefill }) });
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-prefilled')?.textContent).toBe(
      'Filled in from the Ollama that ran here: OLLAMA_KV_CACHE_TYPE=q8_0. Save, then restart to use these.'
    );
  });

  it('names a port held by a program that does not answer, with no Start', async () => {
    const problem = 'Another program is using 127.0.0.1:11434 but does not answer there. Stop it, then check again.';
    await show({
      ...LOCAL,
      health: { ...health, state: 'unreachable' },
      launch: launch({ owner: 'other', canStart: false, problem }),
    });
    expect(byTestId('model-servers-launch-owner')?.textContent).toBe('In use by another program');
    expect(byTestId('model-servers-launch-problem')?.textContent).toBe(problem);
    expect(byTestId('model-servers-launch-start-btn')).toBeNull();
  });

  it('keeps saved launch settings over what it read from the server', async () => {
    const prefill = { settings: { kvCacheType: 'q8_0' as const }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    await show({ ...LOCAL, launch: launch({ prefill, settings: { flashAttention: 'on' } }) });
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-prefilled')).toBeNull();
    await clickId('model-servers-launch-save-btn');
    expect(update).toHaveBeenLastCalledWith('local', { launch: { flashAttention: 'on' } });
  });

  it('shows the values an unmanaged Ollama runs with in its disabled form', async () => {
    const prefill = { settings: { flashAttention: 'off' as const }, from: 'OLLAMA_FLASH_ATTENTION=0' };
    await show({ ...LOCAL, launch: launch({ owner: 'other', canStart: false, prefill }) });
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-prefilled')?.textContent).toBe(
      'Filled in from what this server runs with: OLLAMA_FLASH_ATTENTION=0.'
    );
    expect(byTestId('model-servers-launch-flash-select')?.textContent).toContain('Off');
  });

  it('names the flash attention fit sizes an unmanaged server with when it is not auto', async () => {
    await show({
      ...LOCAL,
      launch: launch({
        owner: 'other',
        canStart: false,
        observed: { OLLAMA_FLASH_ATTENTION: '0' },
        sizingFlashAttention: 'off',
      }),
    });
    expect(byTestId('model-servers-launch-observed')?.textContent).toBe(
      'It runs with OLLAMA_FLASH_ATTENTION=0. Fit badges assume an f16 KV cache with flash attention off.'
    );
  });

  it('says it sizes with f16 when it cannot read an unmanaged server', async () => {
    await show({ ...LOCAL, launch: launch({ owner: 'other', canStart: false }) });
    expect(byTestId('model-servers-launch-observed')?.textContent).toBe(
      "Desktop can't read this server's settings, so fit badges assume an f16 KV cache."
    );
  });

  it('shows only a line for a server on another machine', async () => {
    await show({ ...saved('ollama', 'chat'), launch: launch({ owner: 'remote', canStart: false }) });
    expect(byTestId('model-servers-launch')).toBeNull();
    expect(byTestId('model-servers-launch-locked')?.textContent).toBe(
      "This Ollama server runs on another machine, so Desktop can't start it or apply these settings. Fit badges assume an f16 KV cache, set under Hardware."
    );
  });

  it('asks a llama-server for its models folder and program, and says why its last start failed', async () => {
    await show({
      ...saved('openai-compatible', 'chat'),
      address: 'http://127.0.0.1:8090',
      launch: launch({
        runtime: 'llama-server',
        noun: 'server',
        problem: 'llama-server at /x has no router mode (--models-dir); a newer llama.cpp build is needed',
      }),
    });
    expect(byTestId('model-servers-launch-problem')?.textContent).toContain('no router mode');
    await clickId('model-servers-launch-settings-btn');
    expect(byTestId('model-servers-launch-kv-select')).toBeNull();
    const input = byTestId('model-servers-launch-models-dir-input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, ' /srv/models ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickId('model-servers-launch-save-btn');
    expect(update).toHaveBeenLastCalledWith('gpu', { launch: { modelsDir: '/srv/models' } });
  });
});

describe('probedSummary', () => {
  const GIB = 1024 ** 3;

  it.each([
    [
      'a Mac as memory shared with its GPU',
      { memoryKind: 'unified', totalMemoryBytes: 32 * GIB, gpuMemoryBytes: null, gpuName: null, confidence: 'high' },
      '32 GiB of memory shared with the GPU',
    ],
    [
      'a Strix Halo carve-out as what the GPU can use beside the RAM the OS sees',
      {
        memoryKind: 'unified',
        totalMemoryBytes: 31 * GIB,
        gpuMemoryBytes: 96 * GIB,
        gpuName: 'AMD Radeon 8060S Graphics',
        confidence: 'high',
      },
      '31 GiB of RAM, and the GPU (AMD Radeon 8060S Graphics) can use 96 GiB of memory',
    ],
    [
      'an unconfirmed Strix Halo budget as a lower bound',
      { memoryKind: 'unified', totalMemoryBytes: 62 * GIB, gpuMemoryBytes: 31 * GIB, gpuName: null, confidence: 'low' },
      '62 GiB of RAM, and the GPU can use at least 31 GiB of memory',
    ],
  ] satisfies [string, MachineView, string][])('describes %s', (_label, machine, text) => {
    expect(probedSummary(machine)).toBe(text);
  });
});
