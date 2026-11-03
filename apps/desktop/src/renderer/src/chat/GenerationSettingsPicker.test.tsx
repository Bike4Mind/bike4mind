// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatModelOption } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
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
    topK: { min: 1, max: 200, step: 1, default: 20, scope: 'request' },
    minP: { min: 0, max: 1, step: 0.01, default: 0, scope: 'request' },
    repeatPenalty: { min: 0.5, max: 2, step: 0.01, default: 1.1, scope: 'request' },
    maxOutputTokens: { min: 256, max: 16_384, step: 256, scope: 'request' },
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
    maxOutputTokens: { min: 1024, max: 64_000, step: 256, default: 64_000, scope: 'request' },
    thinkingBudgetTokens: { min: 1024, max: 32_000, step: 1024, default: 16_000, scope: 'request' },
  },
};

describe('GenerationSettingsPicker', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn<(generation: GenerationSettings) => void>();

  async function render(model: ChatModelOption | undefined, generation?: GenerationSettings) {
    await act(async () =>
      root.render(
        <CssVarsProvider>
          <GenerationSettingsPicker model={model} generation={generation} onChange={onChange} />
        </CssVarsProvider>
      )
    );
  }

  function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.querySelector<T>(`[data-testid="${id}"]`);
  }

  async function open() {
    const button = byTestId<HTMLButtonElement>('generation-settings-btn');
    if (!button) throw new Error('The settings button is missing');
    await act(async () => button.click());
  }

  function rows(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid$="-row"]')].map(row =>
      (row.dataset.testid ?? '').replace(/^generation-settings-|-row$/g, '')
    );
  }

  async function type(field: string, text: string) {
    const input = byTestId<HTMLInputElement>(`generation-settings-${field}-input`);
    if (!input) throw new Error(`The ${field} input is missing`);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }

  beforeEach(() => {
    onChange.mockClear();
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
    expect(byTestId('generation-settings-temperature-default')?.textContent).toBe('Model default: 0.6');
    expect(byTestId('generation-settings-maxOutputTokens-default')?.textContent).toBe('Model default');
    expect(byTestId<HTMLInputElement>('generation-settings-temperature-input')?.placeholder).toBe('0.6');
    expect(byTestId('generation-settings-reset-all-btn')).toBeNull();
  });

  it('shows a hosted model its own fields, with temperature locked and nothing to reset', async () => {
    await render(CLAUDE, { temperature: 0.2 });
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: Default');
    await open();
    expect(rows()).toEqual(['temperature', 'maxOutputTokens', 'thinkingBudgetTokens']);
    const temperature = byTestId<HTMLInputElement>('generation-settings-temperature-input');
    expect(temperature?.disabled).toBe(true);
    expect(temperature?.value).toBe('1');
    expect(byTestId('generation-settings-temperature-default')?.textContent).toBe(
      'Claude runs at temperature 1 while it thinks.'
    );
    expect(byTestId('generation-settings-temperature-reset-btn')).toBeNull();
    expect(byTestId('generation-settings-thinkingBudgetTokens-default')?.textContent).toBe('Model default: 16,000');
  });

  it('saves a typed value clamped into range, keeping the other overrides', async () => {
    await render(LOCAL, { topP: 0.9 });
    await open();
    await type('temperature', '5');
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.9, temperature: 2 });
    await type('topK', '33.6');
    expect(onChange).toHaveBeenLastCalledWith({ topP: 0.9, topK: 34 });
  });

  it('counts the overrides the next turn sends, and resets one or all of them', async () => {
    const stored = { temperature: 0.3, topK: 12, thinkingBudgetTokens: 4096 };
    await render(LOCAL, stored);
    expect(byTestId('generation-settings-btn')?.textContent).toBe('Params: 2 set');
    await open();
    expect(byTestId<HTMLInputElement>('generation-settings-temperature-input')?.value).toBe('0.3');

    await act(async () => byTestId('generation-settings-topK-reset-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3, thinkingBudgetTokens: 4096 });

    await act(async () => byTestId('generation-settings-reset-all-btn')?.click());
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('clears an override when its field is emptied', async () => {
    await render(LOCAL, { temperature: 0.3 });
    await open();
    await type('temperature', '');
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('draws nothing for a model with no numeric controls, or before the catalog loads', async () => {
    await render({ id: 'gpt-5', name: 'GPT-5', controls: { effort: { levels: ['low'], scope: 'request' } } });
    expect(container.textContent).toBe('');
    await render(undefined);
    expect(container.textContent).toBe('');
  });
});
