// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageThread } from './MessageThread';
import { buildThread, LARGEST_REAL_SHAPE, STRESS_SHAPE } from './threadFixture';
import { WINDOW_STEP } from './threadWindow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Rounds rendered so far, by the round text they were handed; see the ToolCallList mock. */
const toolListRenders = vi.hoisted(() => ({ count: 0 }));

// The rows themselves are pinned in ToolCallList.open.test.tsx. Stubbed here so the count of
// rounds rendered is directly observable, and so a jsdom parse of thousands of rows is not what
// this file spends its time on.
vi.mock('./ToolCallList', () => ({
  ToolCallList: () => {
    toolListRenders.count++;
    return null;
  },
}));

/** An IntersectionObserver the test drives: each `reveal()` reports every observed sentinel visible. */
class ScriptedObserver {
  static live = new Set<ScriptedObserver>();
  private targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    ScriptedObserver.live.add(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    ScriptedObserver.live.delete(this);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  static reveal() {
    for (const observer of [...ScriptedObserver.live]) {
      const entries = observer.targets.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}

// Stable, as ChatShell's are: a new callback per render would defeat the memo on every turn.
const respond = () => undefined;
const resume = () => undefined;

describe('opening a long conversation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ScriptedObserver);
    Element.prototype.scrollIntoView = () => undefined;
    toolListRenders.count = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ScriptedObserver.live.clear();
    vi.unstubAllGlobals();
  });

  const render = (messages: ChatMessage[], streaming = false) =>
    act(() => {
      root.render(
        <MessageThread
          messages={messages}
          sessionId="s1"
          streaming={streaming}
          onRespond={respond}
          onContinue={resume}
        />
      );
    });

  const count = (testId: string) => container.querySelectorAll(`[data-testid="${testId}"]`).length;

  it('mounts one window of the stress fixture, not its two thousand tool calls', () => {
    render(buildThread(STRESS_SHAPE));

    expect(count('chat-message-round')).toBeLessThanOrEqual(WINDOW_STEP);
    expect(toolListRenders.count).toBeLessThanOrEqual(WINDOW_STEP);
    expect(count('chat-markdown-code-block')).toBeLessThanOrEqual(Math.ceil(WINDOW_STEP / STRESS_SHAPE.codeEvery) + 1);
    expect(count('chat-thread-older-sentinel')).toBe(1);
    expect(count('chat-earlier-messages')).toBe(0);
  });

  it('draws the end of a reply longer than a window, and the rest of it on the way up', () => {
    const messages = buildThread(LARGEST_REAL_SHAPE);
    render(messages);
    expect(count('chat-message-round')).toBe(WINDOW_STEP);
    expect(count('chat-message-user')).toBe(0);

    act(() => ScriptedObserver.reveal());

    // A user turn counts as one unit of the step, so the second step draws one round fewer.
    expect(count('chat-message-user')).toBe(1);
    expect(count('chat-message-round') + count('chat-message-user')).toBe(2 * WINDOW_STEP);
  });

  it('reaches the compaction boundary by scrolling, and only then offers the earlier messages', () => {
    render(buildThread(STRESS_SHAPE));
    for (let step = 0; step < 100 && count('chat-thread-older-sentinel') > 0; step++)
      act(() => ScriptedObserver.reveal());

    expect(count('chat-thread-older-sentinel')).toBe(0);
    expect(count('chat-boundary')).toBe(1);
    expect(count('chat-earlier-messages')).toBe(1);
    const turnsAfterBoundary = STRESS_SHAPE.turns - (STRESS_SHAPE.boundaryAt ?? 0) / 2;
    expect(count('chat-message-assistant')).toBe(turnsAfterBoundary);
  });

  it('re-renders only the reply that is streaming, not the turns above it', () => {
    const messages = buildThread({ ...STRESS_SHAPE, turns: 4, boundaryAt: undefined, roundsPerTurn: 3 });
    render(messages, true);
    const last = messages[messages.length - 1];
    toolListRenders.count = 0;

    render([...messages.slice(0, -1), { ...last, content: `${last.content} more` }], true);

    expect(toolListRenders.count).toBe(last.rounds?.length);
  });
});
