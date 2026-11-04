// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelOption } from '@shared/chat';
import type { ModelLoadOffer, ModelSettings } from '@shared/modelSettings';
import type { LoadedModelState } from '@shared/models';
import { desktopTheme } from '../theme';
import { contextSizeLabel } from '@shared/localContextSetting';
import { contextSent, hasModelDefaults, ModelDefaultsDialog, seedNote, seedsFor } from './ModelDefaultsDialog';

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

const QWEN: ChatModelOption = {
  id: 'local:ollama:qwen3.8:27b',
  name: 'qwen3.8:27b',
  thinkingToggle: true,
  controls: {
    temperature: { min: 0, max: 2, step: 0.05, default: 0.8, scope: 'request' },
    topK: { min: 0, max: 200, step: 1, default: 40, scope: 'request' },
    maxOutputTokens: { min: 256, max: 32_768, step: 256, unlimitedDefault: true, scope: 'request' },
  },
  catalogSampling: { thinking: { temperature: 1, topK: 20 } },
};

const GEMMA: ChatModelOption = {
  ...QWEN,
  id: 'local:ollama:gemma4:12b-it-qat',
  name: 'gemma4:12b-it-qat',
  catalogSampling: { thinking: { temperature: 1, topK: 64 }, nonThinking: { temperature: 1, topK: 40 } },
};

const GPT_OSS: ChatModelOption = {
  id: 'local:ollama:gpt-oss:20b',
  name: 'gpt-oss:20b',
  controls: {
    temperature: { min: 0, max: 2, step: 0.05, default: 1, scope: 'request' },
    effort: { levels: ['low', 'medium', 'high'], scope: 'request' },
  },
};

/** This computer's Ollama: Auto picks 64K, 256K would not load, and the model has an MTP head that is off by default. */
const OLLAMA_OFFER: ModelLoadOffer = {
  context: {
    kind: 'ollama',
    settings: 65536,
    auto: 65536,
    sizes: [
      { size: 16384, tokens: 16384, autoTokens: 16384, loads: true },
      { size: 32768, tokens: 32768, autoTokens: 32768, loads: true },
      { size: 65536, tokens: 65536, autoTokens: 65536, loads: true },
      { size: 131072, tokens: 131072, autoTokens: 65536, loads: true },
      { size: 262144, tokens: 262144, autoTokens: 65536, loads: false },
    ],
    ceiling: 262144,
  },
  draft: { modelDefault: 0, max: 16 },
  keepAlive: true,
};

let root: Root;
let host: HTMLElement;
let stored: ModelSettings;
let offer: ModelLoadOffer;
let loadedState: LoadedModelState;
const setModelSettings = vi.fn<(modelId: string, settings: ModelSettings) => Promise<ModelSettings | null>>();
const getModelLoadOffer = vi.fn<(modelId: string, draftTokens?: number) => Promise<ModelLoadOffer | null>>();

beforeEach(() => {
  stored = {};
  offer = {};
  loadedState = { kind: 'unloaded' };
  setModelSettings.mockReset();
  setModelSettings.mockImplementation(async (_id, settings) => settings);
  getModelLoadOffer.mockReset();
  getModelLoadOffer.mockImplementation(async () => offer);
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { getModelSettings: vi.fn(async () => stored), setModelSettings, getModelLoadOffer },
    models: { getLoadedState: vi.fn(async () => loadedState) },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const onClose = vi.fn();
const onSaved = vi.fn();

async function render(option: ChatModelOption | null) {
  onClose.mockReset();
  onSaved.mockReset();
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelDefaultsDialog option={option} onClose={onClose} onSaved={onSaved} />
      </CssVarsProvider>
    )
  );
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector<T>(`[data-testid="${id}"]`);

function input(field: string): HTMLInputElement {
  const found = byTestId<HTMLInputElement>(`model-defaults-${field}-input`);
  if (!found) throw new Error(`The ${field} input is missing`);
  return found;
}

async function fill(field: string, text: string) {
  const target = input(field);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(target, text);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(id: string) {
  const button = byTestId<HTMLButtonElement>(id);
  if (!button) throw new Error(`${id} is missing`);
  await act(async () => button.click());
}

const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="model-defaults-"][data-testid$="-row"]')].map(row =>
    (row.dataset.testid ?? '').replace(/^model-defaults-|-row$/g, '')
  );

describe('ModelDefaultsDialog', () => {
  it("draws only the fields the model's controls list", async () => {
    await render(QWEN);
    expect(rows()).toEqual(['temperature', 'topK', 'maxOutputTokens']);
    expect(byTestId('model-defaults-effort-select')).toBeNull();
    await render(GPT_OSS);
    expect(rows()).toEqual(['temperature']);
    expect(byTestId('model-defaults-effort-select')).not.toBeNull();
  });

  it('labels each blank field by where its value comes from', async () => {
    await render(GEMMA);
    expect(byTestId('model-defaults-temperature-source')?.textContent).toBe('Catalog: 1.');
    expect(byTestId('model-defaults-topK-source')?.textContent).toBe(
      'Catalog: 64 while thinking. Catalog: 40 with thinking off.'
    );
    expect(byTestId('model-defaults-maxOutputTokens-source')?.textContent).toBe('Model default: no limit.');
    expect(byTestId('model-defaults-maxOutputTokens-source')?.dataset.source).toBe('model default');
    expect(input('topK').placeholder).toBe('64');

    await render(QWEN);
    expect(byTestId('model-defaults-temperature-source')?.textContent).toBe(
      'Catalog: 1 while thinking. Model default: 0.8 with thinking off.'
    );
    expect(byTestId('model-defaults-temperature-source')?.dataset.source).toBe('catalog');
  });

  it('shows the stored defaults and saves what is typed, clamped, with blanks left out', async () => {
    stored = { generation: { temperature: 0.6 } };
    await render(QWEN);
    expect(input('temperature').value).toBe('0.6');
    expect(input('topK').value).toBe('');
    await fill('topK', '500');
    await fill('temperature', '');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, { generation: { topK: 200 } });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a typed value clamped into range once its field loses focus', async () => {
    await render(QWEN);
    await fill('topK', '500');
    await act(async () => {
      input('topK').focus();
      input('topK').blur();
    });
    expect(input('topK').value).toBe('200');
  });

  it('keeps a stored default when its field holds text it cannot parse', async () => {
    stored = { generation: { temperature: 0.6 } };
    await render(QWEN);
    const temperature = input('temperature');
    // A browser reports a number input holding "1e" or "-" as bad input with a blank value; jsdom cannot hold one.
    Object.defineProperty(temperature, 'validity', { configurable: true, value: { badInput: true } });
    await fill('temperature', '');
    await act(async () => {
      temperature.focus();
      temperature.blur();
    });
    expect(temperature.value).toBe('0.6');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, { generation: { temperature: 0.6 } });
  });

  it('saves a thinking level only for a model that lists levels', async () => {
    stored = { effort: 'high' };
    await render(GPT_OSS);
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenLastCalledWith(GPT_OSS.id, { effort: 'high' });

    await render(QWEN);
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenLastCalledWith(QWEN.id, {});
  });

  it('clears every field, and saving that clears the stored defaults', async () => {
    stored = { generation: { temperature: 0.6, topK: 30 } };
    await render(QWEN);
    await click('model-defaults-clear-btn');
    expect(input('temperature').value).toBe('');
    expect(input('topK').value).toBe('');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {});
  });

  it('does not bring a cleared default back when a field then holds text it cannot parse', async () => {
    stored = { generation: { temperature: 0.6 } };
    await render(QWEN);
    await click('model-defaults-clear-btn');
    const temperature = input('temperature');
    Object.defineProperty(temperature, 'validity', { configurable: true, value: { badInput: true } });
    await fill('temperature', '');
    await act(async () => {
      temperature.focus();
      temperature.blur();
    });
    expect(temperature.value).toBe('');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {});
  });

  it('disables Save after a failed read, so it cannot clear what is stored', async () => {
    (window as unknown as { b4m: { chat: { getModelSettings: unknown } } }).b4m.chat.getModelSettings = vi.fn(
      async () => {
        throw new Error('EACCES');
      }
    );
    await render(QWEN);
    expect(byTestId('model-defaults-error')?.textContent).toMatch(/could not read/);
    expect(byTestId<HTMLButtonElement>('model-defaults-save-btn')?.disabled).toBe(true);
    await click('model-defaults-save-btn');
    expect(setModelSettings).not.toHaveBeenCalled();
  });

  it("shows the underlying message of a failed read, not Electron's remote method wrapper", async () => {
    (window as unknown as { b4m: { chat: { getModelSettings: unknown } } }).b4m.chat.getModelSettings = vi.fn(
      async () => {
        throw new Error("Error invoking remote method 'chat:get-model-settings': Error: EACCES: denied");
      }
    );
    await render(QWEN);
    expect(byTestId('model-defaults-error')?.textContent).toBe(
      "Desktop could not read this model's settings: EACCES: denied"
    );
  });

  it('shows the underlying message of a failed save without the wrapper', async () => {
    setModelSettings.mockRejectedValueOnce(
      new Error("Error invoking remote method 'chat:set-model-settings': Error: disk full")
    );
    await render(QWEN);
    await click('model-defaults-save-btn');
    expect(byTestId('model-defaults-error')?.textContent).toBe('Desktop could not save these settings: disk full');
  });

  it("never shows the previous model's drafts when reopened for another model", async () => {
    stored = { generation: { temperature: 0.6 } };
    await render(QWEN);
    await fill('topK', '30');
    stored = {};
    await render(GEMMA);
    expect(input('temperature').value).toBe('');
    expect(input('topK').value).toBe('');
  });

  it('ties each field note to its input', async () => {
    await render(QWEN);
    const note = byTestId('model-defaults-temperature-source');
    expect(note?.id).toBeTruthy();
    expect(input('temperature').getAttribute('aria-describedby')).toBe(note?.id);
  });

  it('stays open and says so when main does not save', async () => {
    setModelSettings.mockResolvedValueOnce(null);
    await render(QWEN);
    await fill('temperature', '0.5');
    await click('model-defaults-save-btn');
    expect(byTestId('model-defaults-error')?.textContent).toMatch(/could not save/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing without a model', async () => {
    await render(null);
    expect(byTestId('model-defaults-dialog')).toBeNull();
  });
});

async function pick(select: string, option: string) {
  await click(`model-defaults-${select}-select`);
  await click(`model-defaults-${select}-option-${option}`);
}

describe('ModelDefaultsDialog load options', () => {
  it('draws no load options when main offers none', async () => {
    await render(QWEN);
    expect(byTestId('model-defaults-load-section')).toBeNull();
    expect(byTestId('model-defaults-context-select')).toBeNull();
  });

  it("draws context, draft and keep-alive for an Ollama model, rating each size and stating Auto's pick", async () => {
    offer = OLLAMA_OFFER;
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('Same as Settings');
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 64K tokens.');
    expect(byTestId('model-defaults-draft-note')?.textContent).toMatch(/^Model default: 0\. 0 turns drafting off/);
    expect(byTestId('model-defaults-keep-alive-select')?.textContent).toBe('Server default');
    await click('model-defaults-context-select');
    expect(byTestId('model-defaults-context-option-262144-note')?.textContent).toMatch(/May not load/);
    expect(byTestId('model-defaults-context-option-131072-note')).toBeNull();
    await click('model-defaults-context-option-auto-131072');
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 64K tokens.');
  });

  it('shows the KV cache type as a server-wide value, with no per-model choice to save', async () => {
    offer = { ...OLLAMA_OFFER, kvCache: { type: 'q8_0' } };
    await render(QWEN);
    expect(byTestId('model-defaults-kv-cache-value')?.textContent).toBe('q8_0');
    expect(byTestId('model-defaults-kv-cache-note')?.textContent).toBe(
      'Set for the whole server with OLLAMA_KV_CACHE_TYPE, as entered under Settings, Model servers, Hardware.'
    );
    expect(byTestId('model-defaults-kv-cache-select')).toBeNull();
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {});

    offer = { kvCache: { type: 'f16' } };
    await render(GEMMA);
    expect(byTestId('model-defaults-load-section')).not.toBeNull();
    expect(byTestId('model-defaults-kv-cache-value')?.textContent).toBe('f16');
    expect(byTestId('model-defaults-kv-cache-note')?.textContent).toMatch(/^Ollama's default\. /);
  });

  it('offers only a smaller context, as a budget, on a server that fixes its own', async () => {
    offer = { context: { kind: 'budget', server: 65536, sizes: [16384, 32768] } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe("Server's 64K tokens");
    expect(byTestId('model-defaults-draft-input')).toBeNull();
    expect(byTestId('model-defaults-keep-alive-select')).toBeNull();
    await click('model-defaults-context-select');
    expect(byTestId('model-defaults-context-option-auto')).toBeNull();
    expect(byTestId('model-defaults-context-option-65536')).toBeNull();
    await click('model-defaults-context-option-32768');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, { context: { mode: 'fixed', tokens: 32768 } });
  });

  it('shows the stored load options and saves each pick beside the sampling', async () => {
    offer = OLLAMA_OFFER;
    stored = { generation: { temperature: 0.6 }, context: { mode: 'auto', maxTokens: 32768 }, draftTokens: 3 };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('Auto, up to 32K tokens');
    expect(input('draft').value).toBe('3');
    await pick('context', '131072');
    await pick('keep-alive', '-1');
    await fill('draft', '16');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {
      generation: { temperature: 0.6 },
      context: { mode: 'fixed', tokens: 131072 },
      draftTokens: 16,
      keepAlive: -1,
    });
  });

  it.each(['40', '1.5', '-1'])('marks a draft count of %s invalid and does not save it', async text => {
    offer = OLLAMA_OFFER;
    await render(QWEN);
    await fill('draft', text);
    expect(input('draft').getAttribute('aria-invalid')).toBe('true');
    expect(byTestId('model-defaults-draft-note')?.textContent).toBe('Enter a whole number from 0 to 16.');
    expect(byTestId<HTMLButtonElement>('model-defaults-save-btn')?.disabled).toBe(true);
    await fill('draft', '2');
    expect(input('draft').getAttribute('aria-invalid')).toBe('false');
    expect(byTestId<HTMLButtonElement>('model-defaults-save-btn')?.disabled).toBe(false);
  });

  it('offers the trained length as a size and stores it, with no Auto cap that repeats Auto', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        auto: 40960,
        ceiling: 40960,
        sizes: [
          { size: 16384, tokens: 16384, autoTokens: 16384, loads: true },
          { size: 32768, tokens: 32768, autoTokens: 32768, loads: true },
          { size: 65536, tokens: 40960, autoTokens: 40960, loads: true },
        ],
      },
    };
    await render(QWEN);
    await click('model-defaults-context-select');
    expect(byTestId('model-defaults-context-option-65536')?.textContent).toBe('40K tokens');
    expect(byTestId('model-defaults-context-option-auto-32768')?.textContent).toBe('Auto, up to 32K tokens');
    expect(byTestId('model-defaults-context-option-auto-65536')).toBeNull();
    await click('model-defaults-context-option-65536');
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 40K tokens.');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, { context: { mode: 'fixed', tokens: 40960 } });
  });

  it('shows a stored trained length as its choice', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        sizes: [{ size: 65536, tokens: 40960, autoTokens: 40960 }],
      },
    };
    stored = { context: { mode: 'fixed', tokens: 40960 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('40K tokens');
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 40K tokens.');
  });

  it('shows a stored size past the trained length as the clamped size chat sends', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        ceiling: 40960,
        sizes: [
          { size: 16384, tokens: 16384, autoTokens: 16384 },
          { size: 65536, tokens: 40960, autoTokens: 40960 },
        ],
      },
    };
    stored = { context: { mode: 'fixed', tokens: 131072 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 40K tokens.');
    expect(contextSent(offer, { mode: 'fixed', tokens: 131072 })).toBe(40960);
  });

  it('validates the draft text itself: whole numbers 0 to the maximum, blank for unset', async () => {
    offer = OLLAMA_OFFER;
    await render(QWEN);
    const field = input('draft');
    const saveDisabled = () => byTestId<HTMLButtonElement>('model-defaults-save-btn')?.disabled;
    for (const [text, invalid] of [
      ['-', true],
      ['1e', true],
      ['17', true],
      ['1.5', true],
      ['4', false],
      ['0', false],
      ['16', false],
    ] as const) {
      await fill('draft', text);
      expect(field.getAttribute('aria-invalid'), text).toBe(String(invalid));
      if (invalid) expect(saveDisabled(), text).toBe(true);
    }
    await fill('draft', '-');
    await fill('draft', '');
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(field.type).toBe('text');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {});
  });

  it('accepts leading zeros and surrounding spaces in the draft text and saves the number', async () => {
    offer = OLLAMA_OFFER;
    await render(QWEN);
    for (const text of ['04', ' 4 ']) {
      await fill('draft', text);
      expect(input('draft').getAttribute('aria-invalid'), text).toBe('false');
      await click('model-defaults-save-btn');
      expect(setModelSettings).toHaveBeenLastCalledWith(QWEN.id, { draftTokens: 4 });
    }
  });

  it('saves a cleared stored draft count as unset', async () => {
    offer = OLLAMA_OFFER;
    stored = { draftTokens: 6 };
    await render(QWEN);
    expect(input('draft').value).toBe('6');
    await fill('draft', '');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, {});
  });

  it('loads a stored Auto cap and a bare Auto into the context choice', async () => {
    offer = OLLAMA_OFFER;
    stored = { context: { mode: 'auto', maxTokens: 32768 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('Auto, up to 32K tokens');
    await act(async () => root.unmount());
    root = createRoot(host);
    offer = {
      context: { kind: 'ollama', settings: 16384, sizes: [{ size: 16384, tokens: 16384, autoTokens: 16384 }] },
    };
    stored = { context: { mode: 'auto' } };
    await render(GEMMA);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('Auto');
  });

  it('warns when a stored size no option lists runs at a listed size that may not load', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        ceiling: 32768,
        sizes: [
          { size: 16384, tokens: 16384, autoTokens: 16384, loads: true },
          { size: 32768, tokens: 32768, autoTokens: 32768, loads: false },
        ],
      },
    };
    stored = { context: { mode: 'fixed', tokens: 131072 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toBe(
      "Runs at 32K tokens. May not load in this computer's memory."
    );
  });

  it('warns about memory for a stored unlisted size that runs at a size that may not load', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        ceiling: 65536,
        sizes: [{ size: 262144, tokens: 65536, autoTokens: 65536, loads: false }],
      },
    };
    stored = { context: { mode: 'fixed', tokens: 262144 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toContain('May not load');
  });

  const autoOffer = (loads16: boolean): ModelLoadOffer => ({
    context: {
      kind: 'ollama',
      settings: 16384,
      auto: 16384,
      ceiling: 32768,
      sizes: [
        { size: 16384, tokens: 16384, autoTokens: 16384, loads: loads16 },
        { size: 32768, tokens: 32768, autoTokens: 16384, loads: false },
      ],
    },
  });

  it('warns when Auto falls back to a floor size that may not load', async () => {
    offer = autoOffer(false);
    stored = { context: { mode: 'auto' } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toBe(
      "Runs at 16K tokens. May not load in this computer's memory."
    );
  });

  it('does not warn when Auto runs at a size that loads', async () => {
    offer = autoOffer(true);
    stored = { context: { mode: 'auto' } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 16K tokens.');
  });

  it('warns under Same as Settings when Settings is a size that may not load', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 32768,
        ceiling: 32768,
        sizes: [
          { size: 16384, tokens: 16384, autoTokens: 16384, loads: true },
          { size: 32768, tokens: 32768, autoTokens: 32768, loads: false },
        ],
      },
    };
    stored = {};
    await render(QWEN);
    expect(byTestId('model-defaults-context-note')?.textContent).toBe(
      "Runs at 32K tokens. May not load in this computer's memory."
    );
  });

  it('shows a stored size a budget server no longer lists, and labels sizes that are not whole K exactly', async () => {
    offer = { context: { kind: 'budget', server: 65536, sizes: [16384] } };
    stored = { context: { mode: 'fixed', tokens: 512 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('512 tokens');
    expect(contextSizeLabel(1536)).toBe('1.5K tokens');
    expect(contextSizeLabel(40000)).toBe('40000 tokens');
    expect(contextSizeLabel(2048)).toBe('2K tokens');
  });

  it('offers a model trained at 4096 its own size and keeps the choice', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 4096,
        sizes: [{ size: 16384, tokens: 4096, autoTokens: 4096, loads: true }],
      },
    };
    await render(QWEN);
    await click('model-defaults-context-select');
    expect(byTestId('model-defaults-context-option-16384')?.textContent).toBe('4K tokens');
    await click('model-defaults-context-option-16384');
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('4K tokens');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenCalledWith(QWEN.id, { context: { mode: 'fixed', tokens: 4096 } });
  });

  it('shows a stored size no option lists as its own choice, with its note', async () => {
    offer = {
      context: {
        kind: 'ollama',
        settings: 16384,
        ceiling: 65536,
        sizes: [{ size: 16384, tokens: 16384, autoTokens: 16384, loads: true }],
      },
    };
    stored = { context: { mode: 'fixed', tokens: 40960 } };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('40K tokens');
    expect(byTestId('model-defaults-context-note')?.textContent).toBe('Runs at 40K tokens.');
  });

  it('labels the default of a saved Ollama server by the context it gets, not the Settings choice', async () => {
    offer = {
      context: { kind: 'ollama', settings: 16384, sizes: [{ size: 16384, tokens: 16384, autoTokens: 16384 }] },
    };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')?.textContent).toBe('Default (16K tokens)');
  });

  it('calls onSaved after a successful save, and not after a failed one', async () => {
    await render(QWEN);
    await fill('temperature', '0.5');
    await click('model-defaults-save-btn');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    setModelSettings.mockResolvedValueOnce(null);
    await click('model-defaults-save-btn');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('rates the sizes again for the draft count typed', async () => {
    offer = OLLAMA_OFFER;
    await render(QWEN);
    expect(getModelLoadOffer).toHaveBeenLastCalledWith(QWEN.id, undefined);
    await fill('draft', '3');
    expect(getModelLoadOffer).toHaveBeenLastCalledWith(QWEN.id, 3);
  });

  it('says a pick reloads the model only when it changes the num_ctx the model is loaded with', async () => {
    offer = OLLAMA_OFFER;
    loadedState = { kind: 'loaded', expiresAt: null, contextLength: 131072 };
    await render(QWEN);
    expect(byTestId('model-defaults-context-reload')).toBeNull();
    await pick('context', '32768');
    expect(byTestId('model-defaults-context-reload')?.textContent).toBe(
      ' Reloads the model, which is loaded at 128K tokens now.'
    );
    await pick('context', '131072');
    expect(byTestId('model-defaults-context-reload')).toBeNull();
  });

  it('keeps the stored load options on save when the offer cannot be read, and clears them with Clear all', async () => {
    getModelLoadOffer.mockRejectedValue(new Error('offline'));
    stored = { context: { mode: 'fixed', tokens: 65536 }, draftTokens: 2, keepAlive: 3600 };
    await render(QWEN);
    expect(byTestId('model-defaults-context-select')).toBeNull();
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenLastCalledWith(QWEN.id, stored);

    await render(QWEN);
    await click('model-defaults-clear-btn');
    await click('model-defaults-save-btn');
    expect(setModelSettings).toHaveBeenLastCalledWith(QWEN.id, {});
  });
});

describe('contextSent', () => {
  it('reads the num_ctx each choice sends from the offer', () => {
    expect(contextSent(OLLAMA_OFFER, null)).toBe(65536);
    expect(contextSent(OLLAMA_OFFER, { mode: 'auto' })).toBe(65536);
    expect(contextSent(OLLAMA_OFFER, { mode: 'auto', maxTokens: 32768 })).toBe(32768);
    expect(contextSent(OLLAMA_OFFER, { mode: 'fixed', tokens: 262144 })).toBe(262144);
    const trained: ModelLoadOffer = {
      context: { kind: 'ollama', settings: 16384, sizes: [{ size: 65536, tokens: 40960, autoTokens: 40960 }] },
    };
    expect(contextSent(trained, { mode: 'fixed', tokens: 40960 })).toBe(40960);
    expect(contextSent(trained, { mode: 'fixed', tokens: 65536 })).toBe(40960);
    expect(contextSent({ context: { kind: 'budget', server: 65536, sizes: [16384] } }, null)).toBeUndefined();
  });
});

describe('seeds', () => {
  it('reads a model that cannot think from the non-thinking sampling only', () => {
    const plain: ChatModelOption = { ...GEMMA, thinkingToggle: undefined };
    const control = plain.controls?.topK;
    if (!control) throw new Error('topK is missing');
    expect(seedNote(seedsFor('topK', control, plain))).toBe('Catalog: 40.');
  });

  it('offers Settings only for a model with something to set', () => {
    expect(hasModelDefaults(QWEN)).toBe(true);
    expect(hasModelDefaults({ controls: { effort: { levels: ['low'], scope: 'request' } } })).toBe(true);
    expect(hasModelDefaults({ controls: {} })).toBe(false);
    expect(hasModelDefaults(null)).toBe(false);
  });
});
