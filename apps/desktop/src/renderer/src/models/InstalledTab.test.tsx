// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalModelEntry } from '@shared/models';
import { desktopTheme } from '../theme';
import { InstalledTab } from './InstalledTab';

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
