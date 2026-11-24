// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { CssVarsProvider } from '@mui/joy/styles';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's
 * vitest runs on `node`, so only the CLOSED control is answerable here - the menu is a portal
 * that mounts on open. That is enough for what these cover: which face the control shows, and
 * that it renders at all, which is what a MenuButton outside its Dropdown fails at.
 */
const MODELS: ChatModelOption[] = [
  { id: 'gpt-5', name: 'GPT-5', supportsReasoningEffort: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', supportsReasoningEffort: false },
];

function markup(
  modelId: string | null,
  models: ChatModelOption[] = MODELS,
  effort: ReasoningEffortSetting = 'high'
): string {
  return renderToStaticMarkup(
    <ReasoningEffortPicker models={models} modelId={modelId} effort={effort} onSelect={() => {}} />
  );
}

const LOCAL_THINKER: ChatModelOption = {
  id: 'qwen3:8b',
  name: 'qwen3:8b',
  backend: 'ollama',
  supportsReasoningEffort: false,
  thinkingToggle: true,
};

describe('ReasoningEffortPicker', () => {
  it('shows the chosen effort on a model that takes one', () => {
    expect(markup('gpt-5')).toContain('Effort: High');
  });

  it('disables itself and says nothing is in effect on a model that does not', () => {
    const html = markup('claude-opus-5');
    expect(html).toContain('Effort: n/a');
    expect(html).not.toContain('Effort: High');
    expect(html).toMatch(/<button[^>]*Mui-disabled/);
  });

  it('stays usable while the catalog has not loaded, rather than guessing a model is unsupported', () => {
    expect(markup('gpt-5', [])).toContain('Effort: High');
    expect(markup(null, [])).toContain('Effort: High');
  });

  it('is a usable thinking switch on a local model that can think, though it takes no effort', () => {
    const on = markup('qwen3:8b', [LOCAL_THINKER], 'default');
    expect(on).toContain('Thinking: On');
    // The button's state class, not the word: Joy's inlined CSS mentions disabled on every control.
    expect(on).not.toMatch(/<button[^>]*Mui-disabled/);
    expect(markup('qwen3:8b', [LOCAL_THINKER], 'none')).toContain('Thinking: Off');
    expect(markup('qwen3:8b', [LOCAL_THINKER], 'minimal')).toContain('Thinking: Off');
  });

  it('shows an older Minimal as On where it was an effort the server ignored, as the request does', () => {
    const learned: ChatModelOption = { ...LOCAL_THINKER, minimalThinks: true };
    expect(markup('qwen3:8b', [learned], 'minimal')).toContain('Thinking: On');
    expect(markup('qwen3:8b', [learned], 'none')).toContain('Thinking: Off');
  });

  it('reads any effort but Off as thinking On, as the request does', () => {
    expect(markup('qwen3:8b', [LOCAL_THINKER], 'high')).toContain('Thinking: On');
  });

  it('keeps a model the catalog never stated a flag for usable', () => {
    expect(markup('some-local-ollama', [{ id: 'some-local-ollama', name: 'Local' }])).toContain('Effort: High');
  });

  it('draws nothing for a local model that cannot think', () => {
    const plain: ChatModelOption = {
      id: 'local:ollama:llama3.2',
      name: 'llama3.2',
      supportsReasoningEffort: false,
      controls: {},
    };
    expect(markup(plain.id, [plain])).toBe('');
  });

  it('draws nothing for an Ollama model not yet inspected, whose controls list no effort', () => {
    const uninspected: ChatModelOption = {
      id: 'local:ollama:qwen3:8b',
      name: 'qwen3:8b',
      backend: 'ollama',
      controls: { temperature: { min: 0, max: 2, step: 0.05, scope: 'request' } },
    };
    expect(markup(uninspected.id, [uninspected])).toBe('');
  });

  it('disables itself on a hosted model whose controls list no effort, whatever its flag says', () => {
    const budget: ChatModelOption = {
      id: 'claude-opus-4-1',
      name: 'Claude Opus 4.1',
      supportsReasoningEffort: true,
      controls: {},
    };
    expect(markup(budget.id, [budget])).toContain('Effort: n/a');
  });

  it('points a model that thinks with a budget to the budget under Params', () => {
    const budget: ChatModelOption = {
      id: 'claude-opus-4-1',
      name: 'Claude Opus 4.1',
      controls: { thinkingBudgetTokens: { min: 1024, max: 31_000, step: 1024, scope: 'request' } },
    };
    expect(markup(budget.id, [budget])).toContain(
      'thinks with a token budget instead of an effort. Set it under Params.'
    );
  });

  it('says a hosted model that cannot stop thinking always thinks, in place of a disabled effort', () => {
    const kimi: ChatModelOption = {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      controls: {},
      thinkingAlwaysOn: true,
    };
    const html = markup(kimi.id, [kimi]);
    expect(html).toContain('Thinking: Always on');
    expect(html).toContain('kimi-k2.7-code always thinks before answering. Its thinking cannot be switched off.');
    expect(html).not.toContain('Effort: n/a');
    expect(html).toMatch(/<button[^>]*Mui-disabled/);
  });

  it('keeps the effort menu on an always-thinking model that lists levels', () => {
    const opus: ChatModelOption = {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      thinkingAlwaysOn: true,
      controls: { effort: { levels: ['low', 'medium', 'high'], scope: 'request' } },
    };
    expect(markup(opus.id, [opus])).toContain('Effort: High');
    expect(markup(opus.id, [opus])).not.toContain('Thinking: Always on');
  });

  it('shows a stored level the model does not list as the nearest level it sends instead', () => {
    const listed: ChatModelOption = {
      id: 'gpt-5',
      name: 'GPT-5',
      supportsReasoningEffort: true,
      controls: { effort: { levels: ['low', 'medium', 'high'], scope: 'request' } },
    };
    expect(markup('gpt-5', [listed], 'minimal')).toContain('Effort: Low');
    expect(markup('gpt-5', [listed], 'xhigh')).toContain('Effort: High');
    expect(markup('gpt-5', [listed], 'default')).toContain('Effort: Default');
  });

  it('shows a stored Off on a local model with think levels as the lowest level it runs at', () => {
    const gptOss: ChatModelOption = {
      id: 'local:ollama:gpt-oss:20b',
      name: 'gpt-oss:20b',
      supportsReasoningEffort: true,
      thinkingToggle: true,
      controls: { effort: { levels: ['low', 'medium', 'high'], scope: 'request' } },
    };
    expect(markup(gptOss.id, [gptOss], 'minimal')).toContain('Effort: Low');
    expect(markup(gptOss.id, [gptOss], 'medium')).toContain('Effort: Medium');
  });
});

describe('the local thinking switch, clicked', () => {
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
      expect(onSelect).toHaveBeenLastCalledWith('none');
      expect(button().textContent).toBe('Thinking: Off');

      await select('On');
      expect(onSelect).toHaveBeenLastCalledWith('default');
      expect(button().textContent).toBe('Thinking: On');
      expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it('shows Off as unavailable on a model that always thinks, and On even for a stored Off', async () => {
      const alwaysOn: ChatModelOption = { ...MODELS[0], id: 'r1', thinkingAlwaysOn: true };
      await act(async () =>
        root.render(
          <CssVarsProvider>
            <ReasoningEffortPicker models={[alwaysOn]} modelId="r1" effort="minimal" onSelect={onSelect} />
          </CssVarsProvider>
        )
      );
      expect(button().textContent).toBe('Thinking: On');
      await act(async () => button().click());
      const off = [...document.querySelectorAll<HTMLElement>('[data-testid="effort-picker-option"]')].find(element =>
        element.textContent?.startsWith('Off')
      );
      expect(off?.getAttribute('aria-disabled')).toBe('true');
      expect(off?.textContent).toContain('This model always thinks.');
      await act(async () => off?.click());
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('cannot open the menu while the control is disabled', async () => {
      await act(async () => root.render(<Picker disabled />));
      expect(button().disabled).toBe(true);
      await act(async () => button().click());
      expect(document.querySelector('[data-testid="effort-picker-option"]')).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('offers only the levels a model lists, besides Default', async () => {
      const gpt: ChatModelOption = {
        id: 'gpt-5',
        name: 'GPT-5',
        supportsReasoningEffort: true,
        controls: { effort: { levels: ['none', 'low', 'high', 'xhigh'], scope: 'request' } },
      };
      await act(async () =>
        root.render(
          <CssVarsProvider>
            <ReasoningEffortPicker models={[gpt]} modelId="gpt-5" effort="default" onSelect={onSelect} />
          </CssVarsProvider>
        )
      );
      await act(async () => button().click());
      const options = [...document.querySelectorAll<HTMLElement>('[data-testid="effort-picker-option"]')];
      // The selected row leads with a bullet; only the label is compared.
      const labels = options.map(option => option.querySelector('p')?.textContent?.replace(/^[^A-Za-z]+/, ''));
      expect(labels).toEqual(['Default', 'None', 'Low', 'High', 'Extra high']);
      await act(async () => options[4]?.click());
      expect(onSelect).toHaveBeenLastCalledWith('xhigh');
    });

    it('names the model default on the Default item when one is set', async () => {
      const gpt: ChatModelOption = {
        id: 'gpt-5',
        name: 'GPT-5',
        supportsReasoningEffort: true,
        controls: { effort: { levels: ['low', 'high'], scope: 'request' } },
      };
      await act(async () =>
        root.render(
          <CssVarsProvider>
            <ReasoningEffortPicker
              models={[gpt]}
              modelId="gpt-5"
              effort="default"
              defaultEffort="high"
              onSelect={onSelect}
            />
          </CssVarsProvider>
        )
      );
      await act(async () => button().click());
      const first = document.querySelector<HTMLElement>('[data-testid="effort-picker-option"]');
      expect(first?.querySelector('p')?.textContent).toContain('Default (High)');
    });
  });
});
