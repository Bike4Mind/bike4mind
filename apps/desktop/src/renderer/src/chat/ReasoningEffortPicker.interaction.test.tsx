// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';

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

const MODELS: ChatModelOption[] = [
  { id: 'qwen3:8b', name: 'Qwen', backend: 'ollama', thinkingToggle: true, supportsReasoningEffort: false },
];

describe('the local thinking switch', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onSelect = vi.fn<(setting: ReasoningEffortSetting) => void>();

  function Picker({ disabled = false }: { disabled?: boolean }) {
    const [effort, setEffort] = useState<ReasoningEffortSetting>('high');
    return (
      <CssVarsProvider>
        <ReasoningEffortPicker
          models={MODELS}
          modelId="qwen3:8b"
          effort={effort}
          disabled={disabled}
          onSelect={setting => {
            onSelect(setting);
            setEffort(setting);
          }}
        />
      </CssVarsProvider>
    );
  }

  function button(): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>('[data-testid="effort-picker-btn"]');
    if (!element) throw new Error('The thinking switch button is missing');
    return element;
  }

  async function select(label: 'On' | 'Off'): Promise<void> {
    await act(async () => button().click());
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="effort-picker-option"]')];
    expect(options).toHaveLength(2);
    const option = options.find(element => element.textContent?.replace(/^\u2022\s*/, '').startsWith(label));
    if (!option) throw new Error(`The ${label} choice is missing`);
    await act(async () => option.click());
  }

  beforeEach(() => {
    onSelect.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('saves Off and On as the settings the next request consumes', async () => {
    await act(async () => root.render(<Picker />));
    expect(button().textContent).toBe('Thinking: On');

    await select('Off');
    expect(onSelect).toHaveBeenLastCalledWith('minimal');
    expect(button().textContent).toBe('Thinking: Off');

    await select('On');
    expect(onSelect).toHaveBeenLastCalledWith('default');
    expect(button().textContent).toBe('Thinking: On');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('cannot open the menu while the control is disabled', async () => {
    await act(async () => root.render(<Picker disabled />));
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(document.querySelector('[data-testid="effort-picker-option"]')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
