// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineView } from '@shared/models';
import type { ModelServerAccess, ModelServerKind, ModelServerProbeResult, ModelServerView } from '@shared/modelServers';
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
    address: 'http://192.168.1.20:11434',
    access,
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: true,
    health: { state: 'online', version: '0.12.0', latencyMs: 12, checkedAt: null, error: null },
    models: ['qwen2.5:0.5b'],
    specs: null,
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
    address: 'https://gpu.example.test',
    access: 'chat',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: false,
    health,
    models: [],
    specs: null,
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
  const probedHardware = vi.fn(async () => ({
    memoryKind: 'cpu' as const,
    totalMemoryBytes: 62 * 1024 ** 3,
    gpuMemoryBytes: null,
    gpuName: null,
    confidence: 'high' as const,
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
