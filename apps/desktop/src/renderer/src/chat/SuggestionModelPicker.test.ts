import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { promptSuggestionsSummary } from './promptSuggestions';
import { suggestionPickerRows } from './SuggestionModelPicker';

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
