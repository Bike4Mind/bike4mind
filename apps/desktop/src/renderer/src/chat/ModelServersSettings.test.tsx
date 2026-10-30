// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineView } from '@shared/models';
import type { ModelServerAccess, ModelServerKind, ModelServerView } from '@shared/modelServers';
import { desktopTheme } from '../theme';
import { ModelServersSettings, probedSummary } from './ModelServersSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

let root: Root;
let host: HTMLElement;
const note = () => document.querySelector<HTMLElement>('[data-testid="model-servers-access-note"]');

async function show(server: ModelServerView) {
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelServersSettings servers={[server]} onServers={() => {}} loadError={null} />
      </CssVarsProvider>
    )
  );
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ModelServersSettings access note', () => {
  it('points an Ollama server set to Chat and manage at the Models screen', async () => {
    await show(saved('ollama', 'manage'));
    expect(note()?.textContent).toMatch(/Download and remove models on this server from the Models screen/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('says only Ollama servers can be managed for an OpenAI-compatible server set to Chat and manage', async () => {
    await show(saved('openai-compatible', 'manage'));
    expect(note()?.textContent).toMatch(/works only on Ollama servers/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('shows no note for a server set to Chat only', async () => {
    await show(saved('ollama', 'chat'));
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
