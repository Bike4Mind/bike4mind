// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatModelCatalog } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPromptSuggestionModel } from './promptSuggestions';
import { SuggestionModelPicker } from './SuggestionModelPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (query => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

describe('SuggestionModelPicker catalog', () => {
  let host: HTMLDivElement;
  let root: Root;
  const list = vi.fn<() => Promise<ChatModelCatalog>>();
  const catalog: ChatModelCatalog = {
    models: [{ id: 'qwen3:8b', name: 'qwen3:8b', backend: 'ollama' }],
  };

  const mount = () =>
    act(async () =>
      root.render(
        <CssVarsProvider>
          <SuggestionModelPicker />
        </CssVarsProvider>
      )
    );

  beforeEach(() => {
    list.mockReset();
    setPromptSuggestionModel('qwen3:8b');
    (window as unknown as { b4m: unknown }).b4m = { chat: { listSuggestionModels: list } };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setPromptSuggestionModel(null);
  });

  it.each(['server', 'IPC'])('shows a %s failure and retries without losing the saved model', async failure => {
    if (failure === 'server') list.mockResolvedValueOnce({ models: [], error: 'Catalog unavailable' });
    else list.mockRejectedValueOnce(new Error('Channel closed'));
    list.mockResolvedValueOnce(catalog);
    await mount();

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain('qwen3:8b');
    expect(host.textContent).not.toContain('(unavailable)');
    expect(host.textContent).not.toContain('billed');

    const refresh = host.querySelector<HTMLButtonElement>('[data-testid="settings-suggestions-model-refresh"]');
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());

    expect(list).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('qwen3:8b (Ollama)');
    expect(host.textContent).toContain("server's configured Ollama endpoint");
    expect(host.textContent).not.toContain('on this machine');
  });

  it('shows loading without asserting availability or hosting before the catalog arrives', async () => {
    list.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(host.textContent).toContain('Loading models');
    expect(host.textContent).toContain('qwen3:8b');
    expect(host.textContent).not.toContain('(unavailable)');
    expect(host.textContent).not.toContain('billed');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="settings-suggestions-model-refresh"]')?.disabled).toBe(
      true
    );
  });

  it('marks a saved model unavailable only after a successful empty catalog', async () => {
    list.mockResolvedValue({ models: [] });
    await mount();
    expect(host.textContent).toContain('qwen3:8b (unavailable)');
    expect(host.textContent).toContain('no hint is shown');
  });
});
