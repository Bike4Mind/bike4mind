// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelOption } from '@shared/chat';
import type { ModelSettings } from '@shared/modelSettings';
import { desktopTheme } from '../theme';
import { hasModelDefaults, ModelDefaultsDialog, seedNote, seedsFor } from './ModelDefaultsDialog';

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

let root: Root;
let host: HTMLElement;
let stored: ModelSettings;
const setModelSettings = vi.fn<(modelId: string, settings: ModelSettings) => Promise<ModelSettings | null>>();

beforeEach(() => {
  stored = {};
  setModelSettings.mockReset();
  setModelSettings.mockImplementation(async (_id, settings) => settings);
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { getModelSettings: vi.fn(async () => stored), setModelSettings },
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

async function render(option: ChatModelOption | null) {
  onClose.mockReset();
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelDefaultsDialog option={option} onClose={onClose} />
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
