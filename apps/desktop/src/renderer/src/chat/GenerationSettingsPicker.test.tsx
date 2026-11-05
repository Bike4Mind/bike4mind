// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
import type { ModelSettings } from '@shared/modelSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationSettingsPicker } from './GenerationSettingsPicker';

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

const LOCAL: ChatModelOption = {
  id: 'local:ollama:qwen3:8b',
  name: 'qwen3:8b',
  controls: {
    temperature: { min: 0, max: 2, step: 0.05, default: 0.6, scope: 'request' },
    topP: { min: 0, max: 1, step: 0.01, default: 0.95, scope: 'request' },
    topK: { min: 0, max: 200, step: 1, default: 20, scope: 'request' },
    minP: { min: 0, max: 1, step: 0.01, default: 0, scope: 'request' },
    repeatPenalty: { min: 0.5, max: 2, step: 0.01, default: 1.1, scope: 'request' },
    maxOutputTokens: {
      min: 256,
      max: 16_384,
      step: 256,
      unlimitedDefault: true,
      includesThinking: true,
      scope: 'request',
    },
    effort: { levels: ['low', 'high'], scope: 'request' },
  },
};

const CLAUDE: ChatModelOption = {
  id: 'claude-sonnet-4-5-20250929',
  name: 'Claude Sonnet 4.5',
  controls: {
    temperature: {
      min: 0,
      max: 1,
      step: 0.05,
      scope: 'request',
      locked: { value: 1, reason: 'Claude runs at temperature 1 while it thinks.' },
    },
    maxOutputTokens: {
      min: 1024,
      max: 64_000,
      step: 256,
      default: 64_000,
      budgetHeadroom: 1000,
      includesThinking: true,
      scope: 'request',
    },
    thinkingBudgetTokens: { min: 1024, max: 32_000, step: 1024, default: 16_000, scope: 'request' },
  },
};

const ADAPTIVE: ChatModelOption = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  controls: {
    maxOutputTokens: { min: 64_000, max: 128_000, step: 256, default: 128_000, scope: 'request' },
  },
};

describe('GenerationSettingsPicker', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn<(generation: GenerationSettings) => Promise<boolean> | void>();

  async function render(
    model: ChatModelOption | undefined,
    generation?: GenerationSettings,
    modelDefaults?: ModelSettings,
    effort: ReasoningEffortSetting = 'default'
  ) {
    await act(async () =>
      root.render(
        <CssVarsProvider>
          <GenerationSettingsPicker
            model={model}
            generation={generation}
            modelDefaults={modelDefaults}
            effort={effort}
            onChange={onChange}
          />
        </CssVarsProvider>
      )
    );
  }

  function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.querySelector<T>(`[data-testid="${id}"]`);
  }

  function input(field: string): HTMLInputElement {
    const found = byTestId<HTMLInputElement>(`generation-settings-${field}-input`);
    if (!found) throw new Error(`The ${field} input is missing`);
    return found;
  }

  async function open() {
    const button = byTestId<HTMLButtonElement>('generation-settings-btn');
    if (!button) throw new Error('The settings button is missing');
    button.focus();
    await act(async () => button.click());
  }

  function rows(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid$="-row"]')].map(row =>
      (row.dataset.testid ?? '').replace(/^generation-settings-|-row$/g, '')
    );
  }

  async function key(target: Element, name: string) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  }

  async function fill(field: string, text: string) {
    const target = input(field);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function type(field: string, text: string) {
    await fill(field, text);
    await key(input(field), 'Enter');
  }

  async function blur(field: string) {
    const target = input(field);
    await act(async () => {
      target.focus();
      target.blur();
    });
  }

  function note(field: string): string | null | undefined {
    return byTestId(`generation-settings-${field}-default`)?.textContent;
  }

  beforeEach(() => {
    onChange.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('lists only the fields a local model takes, each with its model default', async () => {
    await render(LOCAL);
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: Default');
    await open();
    expect(rows()).toEqual(['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'maxOutputTokens']);
    expect(note('temperature')).toBe('Model default: 0.6.');
    expect(note('maxOutputTokens')).toBe('Model default: no limit. Thinking counts toward it.');
    expect(input('temperature').placeholder).toBe('0.6');
    expect(input('maxOutputTokens').placeholder).toBe('No limit');
    expect(byTestId('generation-settings-reset-all-btn')).toBeNull();
  });

  it('shows the Models-screen default a blank field sends in place of the catalog one', async () => {
    await render(LOCAL, undefined, { generation: { temperature: 0.4, maxOutputTokens: 99_999 } });
    await open();
    expect(note('temperature')).toBe('Model default: 0.4.');
    expect(input('temperature').placeholder).toBe('0.4');
    expect(note('topP')).toBe('Model default: 0.95.');
    expect(note('maxOutputTokens')).toBe('Model default: 16,384. Thinking counts toward it.');
  });

  it('shows catalog sampling for the thinking state and lets model defaults override it', async () => {
    const model: ChatModelOption = {
      ...LOCAL,
      thinkingToggle: true,
      controls: { ...LOCAL.controls, effort: undefined },
      catalogSampling: {
        thinking: { temperature: 1, topK: 20 },
        nonThinking: { temperature: 0.7, topK: 40 },
      },
    };
    await render(model);
    await open();
    expect(input('temperature').placeholder).toBe('1');
    expect(note('temperature')).toBe('Model default: 1.');
    expect(onChange).not.toHaveBeenCalled();

    await render(model, undefined, undefined, 'none');
    expect(input('temperature').placeholder).toBe('0.7');
    expect(input('topK').placeholder).toBe('40');

    await render(model, undefined, { generation: { temperature: 0 } }, 'none');
    expect(input('temperature').placeholder).toBe('0');
    expect(input('topK').placeholder).toBe('40');
  });

  it('uses the model default effort to choose the blank field sampling', async () => {
    const model: ChatModelOption = {
      ...LOCAL,
      controls: { ...LOCAL.controls, effort: { levels: ['none', 'low', 'high'], scope: 'request' } },
      catalogSampling: { thinking: { temperature: 1 }, nonThinking: { temperature: 0.7 } },
    };
    await render(model, undefined, { effort: 'none' });
    await open();
    expect(input('temperature').placeholder).toBe('0.7');

    await render(model, undefined, { effort: 'none' }, 'high');
    expect(input('temperature').placeholder).toBe('1');
  });

  it('shows a hosted model its own fields, with temperature locked and nothing to reset', async () => {
    await render(CLAUDE, { temperature: 0.2 });
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: Default');
    await open();
    expect(rows()).toEqual(['temperature', 'maxOutputTokens', 'thinkingBudgetTokens']);
    const temperature = input('temperature');
    expect(temperature.readOnly).toBe(true);
    expect(temperature.disabled).toBe(false);
    expect(temperature.value).toBe('1');
    expect(note('temperature')).toBe('Claude runs at temperature 1 while it thinks.');
    expect(byTestId('generation-settings-temperature-reset-btn')).toBeNull();
    expect(byTestId('generation-settings-reset-all-btn')).toBeNull();
    expect(note('thinkingBudgetTokens')).toBe('Model default: 16,000.');
    expect(input('maxOutputTokens').placeholder).toBe('64000');
    expect(note('maxOutputTokens')).toBe('Model default: 64,000. Thinking counts toward it.');
  });

  it('saves a typed value clamped into range, keeping the other overrides', async () => {
    await render(LOCAL, { topP: 0.9 });
    await open();
    await type('temperature', '5');
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.9, temperature: 2 });
  });

  it('saves nothing when a typed value clamps to the one already stored', async () => {
    await render(LOCAL, { temperature: 2 });
    await open();
    await type('temperature', '5');
    expect(input('temperature').value).toBe('2');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('builds an edit made before main answers on the one still on its way', async () => {
    onChange.mockReturnValue(new Promise<boolean>(() => {}));
    await render(LOCAL, { topP: 0.9, topK: 12 });
    await open();
    await type('temperature', '0.5');
    await act(async () => byTestId('generation-settings-topK-reset-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.9, temperature: 0.5 });
  });

  it('drops an edit main did not save from the next one', async () => {
    onChange.mockResolvedValueOnce(false);
    await render(LOCAL, { topP: 0.9 });
    await open();
    await type('temperature', '0.5');
    await type('topK', '30');
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.9, topK: 30 });
  });

  it('keeps a newer edit on its way when an older one fails', async () => {
    let failFirst: (saved: boolean) => void = () => {};
    onChange.mockImplementationOnce(() => new Promise<boolean>(resolve => (failFirst = resolve)));
    onChange.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    await render(LOCAL);
    await open();
    await type('temperature', '0.5');
    await type('topK', '30');
    await act(async () => failFirst(false));
    await type('minP', '0.1');
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.5, topK: 30, minP: 0.1 });
  });

  it('puts the saved value back in a field whose save failed, and saves it when typed again', async () => {
    onChange.mockResolvedValueOnce(false);
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.5');
    await act(async () => {});
    expect(input('temperature').value).toBe('0.3');
    await type('temperature', '0.5');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer value in a field when an older save of it fails late', async () => {
    let failFirst: (saved: boolean) => void = () => {};
    onChange.mockImplementationOnce(() => new Promise<boolean>(resolve => (failFirst = resolve)));
    onChange.mockResolvedValueOnce(true);
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.5');
    await type('temperature', '0.7');
    await act(async () => failFirst(false));
    expect(input('temperature').value).toBe('0.7');
  });

  it('saves a value again once the chat has gone back to the default', async () => {
    onChange.mockResolvedValue(true);
    await render(LOCAL);
    await open();
    await type('temperature', '0.5');
    await render(LOCAL, { temperature: 0.5 });
    await render(LOCAL, {});
    await type('temperature', '0.5');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('saves a typed value on blur, and once for Enter then blur', async () => {
    await render(LOCAL);
    await open();
    await fill('temperature', '0.5');
    await blur('temperature');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.5 });

    await type('topK', '30');
    await blur('topK');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('counts the overrides the next turn sends, and resets one or all of the shown ones', async () => {
    const stored = { temperature: 0.3, topK: 12, thinkingBudgetTokens: 4096 };
    await render(LOCAL, stored);
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: 2 set');
    await open();
    expect(input('temperature').value).toBe('0.3');

    await act(async () => byTestId('generation-settings-topK-reset-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3, thinkingBudgetTokens: 4096 });

    await act(async () => byTestId('generation-settings-reset-all-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ thinkingBudgetTokens: 4096 });
  });

  it('keeps a locked field override through Reset all', async () => {
    await render(CLAUDE, { temperature: 0.2, maxOutputTokens: 30_000 });
    await open();
    await act(async () => byTestId('generation-settings-reset-all-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.2 });
  });

  it('does not count a default the turn sends as an override', async () => {
    const capped: ChatModelOption = {
      ...CLAUDE,
      controls: {
        ...CLAUDE.controls,
        thinkingBudgetTokens: {
          min: 1024,
          max: 11_000,
          step: 1024,
          default: 11_000,
          sendsDefault: true,
          scope: 'request',
        },
      },
    };
    await render(capped);
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: Default');
    await open();
    expect(input('thinkingBudgetTokens').value).toBe('11000');
  });

  it('shows what the next turn sends for a stored value this model adjusts', async () => {
    await render(ADAPTIVE, { maxOutputTokens: 2048 });
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: 1 set');
    await open();
    expect(input('maxOutputTokens').value).toBe('64000');
    expect(note('maxOutputTokens')).toBe('Model default: 128,000. Saved as 2,048, sent as 64,000 on this model.');
    await blur('maxOutputTokens');
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId('generation-settings-maxOutputTokens-reset-btn')).not.toBeNull();
  });

  it('saves the value sent on this model when it is typed over a stored one it adjusts', async () => {
    await render(ADAPTIVE, { maxOutputTokens: 2048 });
    await open();
    await fill('maxOutputTokens', '');
    await type('maxOutputTokens', '64000');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ maxOutputTokens: 64_000 });
  });

  it('raises the max output floor with the thinking budget the turn sends', async () => {
    await render(CLAUDE, { thinkingBudgetTokens: 20_000, maxOutputTokens: 4096 });
    await open();
    expect(input('maxOutputTokens').value).toBe('21000');
    expect(input('maxOutputTokens').min).toBe('21000');
  });

  it('commits nothing for a field left as it was shown', async () => {
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await blur('temperature');
    await blur('topP');
    await type('temperature', '0.30');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears an override when its field is emptied', async () => {
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '');
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('keeps the saved value when a field holds text it cannot parse', async () => {
    await render(LOCAL, { temperature: 0.3 });
    await open();
    const temperature = input('temperature');
    // A browser reports a number input holding "1e" or "-" as bad input with a blank value; jsdom cannot hold one.
    Object.defineProperty(temperature, 'validity', { configurable: true, value: { badInput: true } });
    await fill('temperature', '');
    await blur('temperature');
    expect(temperature.value).toBe('0.3');
    await fill('temperature', '');
    await key(temperature, 'Enter');
    expect(temperature.value).toBe('0.3');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not save the shown value over a stored one after a bad entry and a plain focus', async () => {
    await render(ADAPTIVE, { maxOutputTokens: 2048 });
    await open();
    const field = input('maxOutputTokens');
    const bad = Object.defineProperty(field, 'validity', { configurable: true, value: { badInput: true } });
    await fill('maxOutputTokens', '');
    await blur('maxOutputTokens');
    Object.defineProperty(bad, 'validity', { configurable: true, value: { badInput: false } });
    await blur('maxOutputTokens');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not save a typed value that equals the stored one when the model adjusts it', async () => {
    await render(ADAPTIVE, { maxOutputTokens: 2048 });
    await open();
    await type('maxOutputTokens', '2048');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('compares a retyped value with what this field just saved while the stored prop is stale', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.9');
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.9 });
    await type('temperature', '0.3');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3 });
  });

  it('saves a stored value retyped after its field Reset while that save is still on its way', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await act(async () => byTestId('generation-settings-temperature-reset-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({});
    await fill('temperature', '');
    await type('temperature', '0.3');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3 });
  });

  it('saves a stored value retyped after Reset all while that save is still on its way', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await act(async () => byTestId('generation-settings-reset-all-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({});
    await fill('temperature', '');
    await type('temperature', '0.3');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3 });
  });

  it('saves a value retyped after its field Reset when the first save of it is still on its way', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.9');
    await act(async () => byTestId('generation-settings-temperature-reset-btn')?.click());
    await fill('temperature', '');
    await type('temperature', '0.9');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.9 });
  });

  it('saves a value retyped after Reset all when the first save of it is still on its way', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.9');
    await act(async () => byTestId('generation-settings-reset-all-btn')?.click());
    await fill('temperature', '');
    await type('temperature', '0.9');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.9 });
  });

  it('saves a stored value retyped after the dialog closes and reopens mid-save', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '0.9');
    await key(input('temperature'), 'Escape');
    await open();
    await fill('temperature', '');
    await type('temperature', '0.3');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3 });
  });

  it('clears a value that was saved while the stored prop is still blank', async () => {
    onChange.mockReturnValue(new Promise(() => {}));
    await render(LOCAL);
    await open();
    await type('temperature', '0.9');
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.9 });
    await type('temperature', '');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('saves nothing for a blank field with no stored override', async () => {
    await render(LOCAL);
    await open();
    await fill('temperature', '0.9');
    await type('temperature', '');
    await blur('temperature');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('draws nothing for a model with no numeric controls, or before the catalog loads', async () => {
    await render({ id: 'gpt-5', name: 'GPT-5', controls: { effort: { levels: ['low'], scope: 'request' } } });
    expect(container.textContent).toBe('');
    await render(undefined);
    expect(container.textContent).toBe('');
  });

  describe('as a dialog', () => {
    it('is named, moves focus to the first field it can edit, and describes each field', async () => {
      await render(CLAUDE, { maxOutputTokens: 30_000 });
      const button = byTestId<HTMLButtonElement>('generation-settings-btn');
      expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
      await open();
      const dialog = document.querySelector('[role="dialog"]');
      const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
      expect(title?.textContent).toBe('Params');
      const intro = document.getElementById(dialog?.getAttribute('aria-describedby') ?? '');
      expect(intro?.textContent).toBe('For this chat only. A blank field uses the model default.');
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(button?.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(input('maxOutputTokens'));
      for (const field of ['temperature', 'maxOutputTokens']) {
        const described = document.getElementById(input(field).getAttribute('aria-describedby') ?? '');
        expect(described?.textContent).toBe(note(field));
      }
      expect(byTestId('generation-settings-maxOutputTokens-reset-btn')?.getAttribute('aria-label')).toBe(
        'Reset Max output tokens'
      );
    });

    it('keeps typing keys in the field, and closes on Escape with focus back on the button', async () => {
      await render(LOCAL);
      await open();
      const temperature = input('temperature');
      expect(document.activeElement).toBe(temperature);
      await key(temperature, 'ArrowDown');
      await key(temperature, 'a');
      expect(document.activeElement).toBe(temperature);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await key(temperature, 'Escape');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(byTestId('generation-settings-btn'));
    });

    it('drops a typed value on Escape, even when the field blurs before the dialog closes', async () => {
      await render(LOCAL);
      await open();
      await fill('temperature', '0.5');
      const temperature = input('temperature');
      const blurAfterReact = () => temperature.blur();
      document.body.addEventListener('keydown', blurAfterReact);
      await key(temperature, 'Escape');
      document.body.removeEventListener('keydown', blurAfterReact);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('lets a locked field take focus so its reason can be read', async () => {
      await render(CLAUDE);
      await open();
      const temperature = input('temperature');
      await act(async () => temperature.focus());
      expect(document.activeElement).toBe(temperature);
      await type('temperature', '0.4');
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
