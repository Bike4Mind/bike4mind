// @vitest-environment jsdom
import type { ChatModelOption, ChatModelCatalog, ChatStreamEvent } from '@shared/chat';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { promptSuggestionsSummary, setPromptSuggestionModel, setPromptSuggestionsEnabled } from './promptSuggestions';
import { suggestionPickerRows, SuggestionModelPicker } from './SuggestionModelPicker';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { usePromptSuggestion, type PromptSuggestionController } from './usePromptSuggestion';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const haiku: ChatModelOption = { id: 'claude-haiku-4-5-20251001', name: 'Claude 4.5 Haiku', backend: 'anthropic' };
const qwen: ChatModelOption = { id: 'qwen3:8b', name: 'qwen3:8b', backend: 'ollama' };
const deviceQwen: ChatModelOption = { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama' };
const deviceOther: ChatModelOption = { id: 'local:lmstudio:qwen3-8b', name: 'qwen3-8b', backend: 'local-lmstudio' };

describe('suggestionPickerRows', () => {
  it('marks local models so they read apart from hosted ones', () => {
    expect(suggestionPickerRows([haiku, qwen], null).map(row => row.label)).toEqual([
      'Claude 4.5 Haiku',
      'qwen3:8b (Ollama)',
    ]);
  });

  // Device models must not read as hosted, nor as the server's Ollama endpoint.
  it('marks device-local models of any runtime apart from the server Ollama', () => {
    expect(suggestionPickerRows([qwen, deviceQwen, deviceOther], null)).toEqual([
      { id: 'qwen3:8b', label: 'qwen3:8b (Ollama)', local: true, device: false, unavailable: false },
      { id: 'local:ollama:qwen3:8b', label: 'qwen3:8b (local)', local: true, device: true, unavailable: false },
      { id: 'local:lmstudio:qwen3-8b', label: 'qwen3-8b (local)', local: true, device: true, unavailable: false },
    ]);
  });

  // Main declines on a pick it does not offer; the picker has to say so instead of looking automatic.
  it('keeps a saved pick the server no longer offers, marked unavailable', () => {
    expect(suggestionPickerRows([haiku], 'qwen3:8b').at(-1)).toMatchObject({
      id: 'qwen3:8b',
      label: 'qwen3:8b (unavailable)',
      unavailable: true,
    });
  });

  it('does not call a saved pick unavailable before the list has arrived', () => {
    expect(suggestionPickerRows(null, 'qwen3:8b')).toEqual([
      { id: 'qwen3:8b', label: 'qwen3:8b', local: false, device: false, unavailable: false },
    ]);
  });

  it.each([null, []])('preserves a saved device model classification with catalog %j', offered => {
    for (const model of [deviceQwen, deviceOther]) {
      expect(suggestionPickerRows(offered, model.id)).toEqual([
        expect.objectContaining({ id: model.id, local: true, device: true, unavailable: offered !== null }),
      ]);
    }
  });
});

describe('promptSuggestionsSummary', () => {
  it('names a pinned model and stays short for automatic', () => {
    expect(promptSuggestionsSummary(true, 'qwen3:8b')).toBe('On, qwen3:8b');
    expect(promptSuggestionsSummary(true)).toBe('On');
    expect(promptSuggestionsSummary(false, 'qwen3:8b')).toBe('Off');
  });
});

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
    (window as unknown as { b4m: unknown }).b4m = {
      host: chatBackedHostBridge(),
      chat: { listSuggestionModels: list },
    };
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

  it('says a device-local pick runs on this device, not on the server', async () => {
    setPromptSuggestionModel('local:ollama:qwen3:8b');
    list.mockResolvedValueOnce({
      models: [{ id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama' }],
    });
    await mount();

    expect(host.textContent).toContain('qwen3:8b (local)');
    expect(host.textContent).toContain('Runs on this device');
    expect(host.textContent).not.toContain("server's configured Ollama endpoint");
    expect(host.textContent).not.toContain('billed');
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

  it.each(['local:ollama:qwen3:8b', 'local:lmstudio:qwen3-8b'])(
    'keeps an unavailable device model %s on the device side of the caption',
    async modelId => {
      setPromptSuggestionModel(modelId);
      list.mockResolvedValue({ models: [] });
      await mount();

      expect(host.textContent).toContain(`${modelId} (unavailable)`);
      expect(host.textContent).toContain('unavailable on this device');
      expect(host.textContent).toContain('no hint is shown');
      expect(host.textContent).not.toContain('This server does not offer');
      expect(host.textContent).not.toContain('billed');
    }
  );
});

describe('usePromptSuggestion', () => {
  function deferredAnswer() {
    let resolve: (answer: string | null) => void = () => {
      throw new Error('Promise not initialized');
    };
    const promise = new Promise<string | null>(complete => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  describe('usePromptSuggestion', () => {
    let listener: ((event: ChatStreamEvent) => void) | null;
    let controller: PromptSuggestionController | null;
    let container: HTMLElement;
    let root: Root;
    let asked: (string | null | undefined)[];
    let answer: () => Promise<string | null>;

    function Probe({ sessionId }: { sessionId: string | null }) {
      controller = usePromptSuggestion(sessionId);
      return null;
    }

    const render = (sessionId: string | null) => act(async () => root.render(<Probe sessionId={sessionId} />));
    const emit = (event: ChatStreamEvent) => act(async () => listener?.(event));
    const settle = (sessionId = 's1') => emit({ type: 'done', sessionId, messageId: 'm1', content: 'Done.' });

    beforeEach(() => {
      listener = null;
      controller = null;
      setPromptSuggestionsEnabled(true);
      setPromptSuggestionModel(null);
      asked = [];
      answer = async () => 'Add a test';
      (window as unknown as { b4m: unknown }).b4m = {
        host: chatBackedHostBridge(),
        chat: {
          suggestNextPrompt: async (_sessionId: string, model?: string | null) => {
            asked.push(model);
            return answer();
          },
          onStreamEvent: (next: (event: ChatStreamEvent) => void) => {
            listener = next;
            return () => undefined;
          },
        },
      };
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    it('offers a guess once a turn settles', async () => {
      await render('s1');
      await settle();
      expect(controller?.suggestion).toBe('Add a test');
    });

    it('clears it when the next turn starts', async () => {
      await render('s1');
      await settle();
      await emit({ type: 'start', sessionId: 's1', messageId: 'm2' });
      expect(controller?.suggestion).toBeNull();
    });

    it('clears it on a session switch', async () => {
      await render('s1');
      await settle();
      await render('s2');
      expect(controller?.suggestion).toBeNull();
    });

    it('clears it when dismissed on send', async () => {
      await render('s1');
      await settle();
      await act(async () => controller?.dismiss());
      expect(controller?.suggestion).toBeNull();
    });

    it('clears it when the setting is turned off', async () => {
      await render('s1');
      await settle();
      await act(async () => setPromptSuggestionsEnabled(false));
      expect(controller?.suggestion).toBeNull();
    });

    it('asks with the model picked in Settings at the time of the call', async () => {
      await render('s1');
      await settle();
      await act(async () => setPromptSuggestionModel('qwen3:8b'));
      await settle();
      expect(asked).toEqual([null, 'qwen3:8b']);
    });

    it('clears the visible hint when the selected model changes', async () => {
      await render('s1');
      await settle();
      await act(async () => setPromptSuggestionModel('qwen3:8b'));
      expect(controller?.suggestion).toBeNull();
    });

    it.each(['model', 'disabled', 'disabled then enabled', 'session', 'dismissed', 'new turn'])(
      'discards a pending answer after the preference or conversation is %s',
      async change => {
        const pending = deferredAnswer();
        answer = () => pending.promise;
        await render('s1');
        await settle();

        if (change === 'model') await act(async () => setPromptSuggestionModel('qwen3:8b'));
        if (change === 'disabled' || change === 'disabled then enabled') {
          await act(async () => setPromptSuggestionsEnabled(false));
        }
        if (change === 'disabled then enabled') await act(async () => setPromptSuggestionsEnabled(true));
        if (change === 'session') await render('s2');
        if (change === 'dismissed') await act(async () => controller?.dismiss());
        if (change === 'new turn') await emit({ type: 'start', sessionId: 's1', messageId: 'm2' });

        await act(async () => pending.resolve('An outdated suggestion'));
        expect(controller?.suggestion).toBeNull();
      }
    );

    it('checks the current preference before accepting an answer in the same event', async () => {
      const pending = deferredAnswer();
      answer = () => pending.promise;
      await render('s1');
      await settle();
      await act(async () => {
        setPromptSuggestionModel('qwen3:8b');
        pending.resolve('An outdated suggestion');
        await pending.promise;
      });
      expect(controller?.suggestion).toBeNull();
    });
  });
});
