import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';

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
