// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '@shared/chat';
import { setPromptSuggestionModel, setPromptSuggestionsEnabled } from './promptSuggestions';
import { usePromptSuggestion, type PromptSuggestionController } from './usePromptSuggestion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('usePromptSuggestion', () => {
  let listener: ((event: ChatStreamEvent) => void) | null;
  let controller: PromptSuggestionController | null;
  let container: HTMLElement;
  let root: Root;
  let asked: (string | null | undefined)[];

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
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        suggestNextPrompt: async (_sessionId: string, model?: string | null) => {
          asked.push(model);
          return 'Add a test';
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
});
