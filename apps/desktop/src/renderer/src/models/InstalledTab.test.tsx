// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelOption } from '@shared/chat';
import type { LocalModelEntry } from '@shared/models';
import { desktopTheme } from '../theme';
import { installedCache } from './installedCache';
import { InstalledTab, inUseWarning } from './InstalledTab';

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

const bare = {
  sizeBytes: null,
  quantization: null,
  family: null,
  parameterSize: null,
  modifiedAt: null,
  capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: false },
  loaded: false,
  fit: null,
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const row = (name: string) =>
  host.querySelector<HTMLElement>(`[data-testid="models-installed-row"][data-name="${name}"]`);
const within = (parent: HTMLElement | null, testId: string) =>
  parent?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent ?? null;

describe('InstalledTab on a vLLM server', () => {
  it('shows a model once with its other served names and context, and an adapter with its base', async () => {
    const models: LocalModelEntry[] = [
      { ...bare, name: 'qwen-small', contextLength: 4096, aliases: ['qwen'] },
      { ...bare, name: 'sql-lora', contextLength: 4096, baseModel: 'qwen-small' },
    ];
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <InstalledTab
            status={null}
            target={{ id: 'gpu', name: 'gpu vllm', local: false, management: 'unsupported' }}
            installed={{ ok: true, models }}
            onRetry={() => {}}
            onExplore={() => {}}
          />
        </CssVarsProvider>
      )
    );
    expect(host.querySelectorAll('[data-testid="models-installed-row"]')).toHaveLength(2);
    expect(within(row('qwen-small'), 'models-installed-aliases')).toBe('Also served as qwen');
    expect(within(row('qwen-small'), 'models-installed-context')).toBe('4K context');
    expect(within(row('qwen-small'), 'models-installed-lora-chip')).toBeNull();
    expect(within(row('sql-lora'), 'models-installed-lora-chip')).toBe('LoRA on qwen-small');
    expect(within(row('sql-lora'), 'models-installed-context')).toBe('4K context');
  });
});

describe('InstalledTab embedding-only rows', () => {
  it('says why an embedding-only model has no Use in chat button, and leaves chat models alone', async () => {
    const models: LocalModelEntry[] = [
      { ...bare, name: 'qwen3-embedding:0.6b', capabilities: { ...bare.capabilities, embeddings: true } },
      { ...bare, name: 'llama3', capabilities: { ...bare.capabilities, completion: true } },
    ];
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <InstalledTab
            status={null}
            target={{ id: 'local', name: 'This computer', local: true, management: 'unsupported' }}
            installed={{ ok: true, models }}
            chatOn={name => (name === 'llama3' ? () => {} : null)}
            onRetry={() => {}}
            onExplore={() => {}}
          />
        </CssVarsProvider>
      )
    );
    const note = row('qwen3-embedding:0.6b')?.querySelector('[data-testid="models-installed-embedding-note"]');
    expect(note?.textContent).toBe('Embedding model, not for chat');
    expect(note?.getAttribute('role')).toBe('note');
    expect(within(row('qwen3-embedding:0.6b'), 'models-installed-use-btn')).toBeNull();
    expect(within(row('llama3'), 'models-installed-embedding-note')).toBeNull();
    expect(within(row('llama3'), 'models-installed-use-btn')).toBe('Use in chat');
  });
});

describe('InstalledTab model settings', () => {
  it("offers Settings for a model chat lists with controls, and opens that model's dialog", async () => {
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        getModelSettings: async () => ({}),
        getUnsupportedModelSettings: async () => [],
        getModelLoadOffer: async () => ({}),
      },
      models: { getLoadedState: async () => ({ kind: 'unloaded' }) },
    };
    const chatModel: ChatModelOption = {
      id: 'local:ollama:llama3',
      name: 'llama3',
      controls: { temperature: { min: 0, max: 2, step: 0.05, default: 0.8, scope: 'request' } },
    };
    const models: LocalModelEntry[] = [
      { ...bare, name: 'llama3', capabilities: { ...bare.capabilities, completion: true } },
      { ...bare, name: 'nomic-embed', capabilities: { ...bare.capabilities, embeddings: true } },
      { ...bare, name: 'bare-model', capabilities: { ...bare.capabilities, completion: true } },
    ];
    const bareOption: ChatModelOption = { id: 'local:ollama:bare-model', name: 'bare-model', controls: {} };
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <InstalledTab
            status={null}
            target={{ id: 'local', name: 'This computer', local: true, management: 'allowed' }}
            installed={{ ok: true, models }}
            modelOn={name => (name === 'llama3' ? chatModel : name === 'bare-model' ? bareOption : null)}
            onRetry={() => {}}
            onExplore={() => {}}
          />
        </CssVarsProvider>
      )
    );
    expect(within(row('nomic-embed'), 'models-installed-settings-btn')).toBeNull();
    expect(within(row('bare-model'), 'models-installed-settings-btn')).toBeNull();
    const button = row('llama3')?.querySelector<HTMLButtonElement>('[data-testid="models-installed-settings-btn"]');
    expect(button?.textContent).toBe('Settings');
    await act(async () => button?.click());
    expect(document.querySelector('[data-testid="model-defaults-dialog"]')?.textContent).toContain(
      'Settings for llama3'
    );
    expect(document.querySelector('[data-testid="model-defaults-temperature-input"]')).not.toBeNull();
  });
});

describe('InstalledTab last known list', () => {
  const qwen: LocalModelEntry = { ...bare, name: 'qwen2.5:0.5b' };
  const llama: LocalModelEntry = { ...bare, name: 'llama3.2:3b' };
  const gpu = { id: 'gpu', name: 'gpu box', local: false, management: 'allowed' } as const;
  const reachable = {
    reachable: true,
    version: '0.40.11',
    url: 'http://gpu:11434',
    error: null,
    serverId: 'gpu',
    serverName: 'gpu box',
    management: 'allowed',
  } as const;
  const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

  it('shows the last list with why it is stale, and checks again on request', async () => {
    const onRetry = vi.fn();
    const show = (props: Pick<Parameters<typeof InstalledTab>[0], 'status' | 'installed'>) =>
      act(async () =>
        root.render(
          <CssVarsProvider theme={desktopTheme}>
            <InstalledTab
              {...props}
              target={gpu}
              lastInstalled={{ models: [qwen], listedAt: Date.now() }}
              onRetry={onRetry}
              onExplore={() => {}}
            />
          </CssVarsProvider>
        )
      );

    await show({
      status: { ...reachable, reachable: false, error: 'Could not reach gpu box: refused' },
      installed: null,
    });
    expect(host.querySelector('[data-testid="models-installed-runtime-down"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="models-installed-row"]')).toHaveLength(1);
    expect(text('models-installed-stale-reason')).toBe('Could not reach gpu box: refused');
    expect(text('models-installed-stale')).toContain('Showing the list from');
    await act(async () => host.querySelector<HTMLElement>('[data-testid="models-installed-stale-retry-btn"]')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    await show({
      status: reachable,
      installed: { ok: false, error: { kind: 'failed', message: 'Listing timed out' } },
    });
    expect(host.querySelector('[data-testid="models-installed-error"]')).toBeNull();
    expect(text('models-installed-stale-reason')).toBe('Listing timed out');
  });

  // A listing in flight across the delete may still name the model; useModelHub drops listings started before a cut.
  it('cuts listings before and after a removal, and drops the model from the cached list', async () => {
    installedCache.clear();
    installedCache.set('gpu', 'identity', [qwen, llama], 1);
    const cutsAtDelete: number[] = [];
    (window as unknown as { b4m: unknown }).b4m = {
      models: {
        remove: async () => {
          cutsAtDelete.push(installedCache.cuts('gpu'));
          return { ok: true };
        },
      },
    };
    await act(async () =>
      root.render(
        <CssVarsProvider theme={desktopTheme}>
          <InstalledTab
            status={reachable}
            target={gpu}
            installed={{ ok: true, models: [qwen, llama] }}
            onRetry={() => {}}
            onExplore={() => {}}
          />
        </CssVarsProvider>
      )
    );
    await act(async () =>
      row('qwen2.5:0.5b')?.querySelector<HTMLElement>('[data-testid="models-installed-remove-btn"]')?.click()
    );
    await act(async () =>
      document.querySelector<HTMLElement>('[data-testid="models-remove-dialog-confirm-btn"]')?.click()
    );
    expect(cutsAtDelete).toEqual([1]);
    expect(installedCache.cuts('gpu')).toBe(2);
    expect(installedCache.get('gpu', 'identity')?.models.map(model => model.name)).toEqual(['llama3.2:3b']);
    installedCache.clear();
  });
});

describe('inUseWarning', () => {
  const qwen: LocalModelEntry = { ...bare, name: 'qwen2.5:0.5b' };
  const on = (serverId: string, name = 'qwen2.5:0.5b') => ({ serverId, name });

  it('names the open conversation first, else counts the conversations on the same server', () => {
    expect(inUseWarning(qwen, 'local', { active: on('local'), conversations: [on('local')] })).toContain(
      'The open conversation uses this model.'
    );
    expect(
      inUseWarning(qwen, 'local', {
        active: null,
        conversations: [on('local'), on('local'), on('gpu'), on('local', 'llama')],
      })
    ).toContain('2 conversations use this model.');
    expect(inUseWarning(qwen, 'local', { active: on('gpu'), conversations: [] })).toBeNull();
  });
});
