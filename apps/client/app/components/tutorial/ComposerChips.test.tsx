import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@client/app/utils/react-query', () => ({ setOptimisticQueryData: vi.fn() }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: {
    getState: () => ({ chatInputValue: '', setDraft: vi.fn(), setChatInputValue: vi.fn(), clearDraft: vi.fn() }),
    subscribe: () => () => undefined,
  },
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('./CoachMark', () => ({ CoachMark: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));

import { HideUnusedComposerChips, unusedComposerChips } from './ComposerChips';
import { TutorialRunner } from './TutorialRunner';
import type { TutorialScript, TutorialTransport } from './types';
import { TutorialHostProvider } from './TutorialHostContext';
import { tutorialStoreFor } from './useTutorialStore';

const BASE = '/api/test-tutorials';
const useTutorialStore = {
  setState: tutorialStoreFor(BASE).setState,
  getState: () => tutorialStoreFor(BASE).getState(),
};

// Core's testids, written out rather than read from COMPOSER_CHIPS, so dropping or misspelling one fails.
const CORE_CHIPS = [
  'ai-settings-btn',
  'session-tools-dropdown-toggle',
  'session-agents-dropdown-toggle',
  'voice-record-btn',
  'conversational-voice-btn',
];
const KEPT = ['send-message-btn', 'attach-files-btn'];

const script: TutorialScript = {
  id: 'demo',
  steps: [
    { id: 'intro', type: 'point', body: 'Here is the problem.' },
    { id: 'ask', type: 'prompt', body: 'Send it.', turn: 1, prompt: 'What next?', anchor: 'send-message-btn' },
  ],
};

const mount = (testid: string, parent: HTMLElement) => {
  const el = document.createElement('button');
  el.setAttribute('data-testid', testid);
  parent.appendChild(el);
  return el;
};
const hidden = (el: HTMLElement) => getComputedStyle(el).display === 'none';

let composer: HTMLElement;
let chips: HTMLElement[];
let kept: HTMLElement[];
beforeEach(() => {
  composer = document.createElement('div');
  composer.setAttribute('data-testid', 'session-bottom-container');
  document.body.appendChild(composer);
  chips = CORE_CHIPS.map(testid => mount(testid, composer));
  kept = KEPT.map(testid => mount(testid, composer));
  useTutorialStore.setState({ active: null });
});
afterEach(() => composer.remove());

describe('HideUnusedComposerChips', () => {
  it('hides every composer chip while mounted, and leaves Send and the attach control alone', () => {
    render(<HideUnusedComposerChips script={script} />);
    expect(chips.filter(hidden)).toHaveLength(CORE_CHIPS.length);
    expect(kept.some(hidden)).toBe(false);
  });

  it('brings them back once it unmounts', () => {
    const { unmount } = render(<HideUnusedComposerChips script={script} />);
    unmount();
    expect(chips.some(hidden)).toBe(false);
  });

  it('leaves a chip outside the composer alone', () => {
    const elsewhere = mount('session-agents-dropdown-toggle', document.body);
    render(<HideUnusedComposerChips script={script} />);
    expect(hidden(elsewhere)).toBe(false);
    elsewhere.remove();
  });

  it('keeps a chip a step points at', () => {
    const using: TutorialScript = {
      id: 'tools',
      steps: [{ id: 'tools', type: 'point', body: 'Open Tools.', anchor: 'session-tools-dropdown-toggle' }],
    };
    expect(unusedComposerChips(using)).not.toContain('session-tools-dropdown-toggle');
    render(<HideUnusedComposerChips script={using} />);
    expect(hidden(chips[CORE_CHIPS.indexOf('session-tools-dropdown-toggle')])).toBe(false);
    expect(hidden(chips[CORE_CHIPS.indexOf('session-agents-dropdown-toggle')])).toBe(true);
  });
});

describe('the runner', () => {
  const transport: TutorialTransport = {
    progress: vi.fn(async () => ({})),
    start: vi.fn(async () => ({ sessionId: 's1' })),
    resume: vi.fn(async () => ({ sessionId: 's1' })),
    sheet: vi.fn(async () => ({ fileId: 'f1' })),
    advance: vi.fn(async () => ({ quest: { id: 'q1' } })),
    position: vi.fn(async () => undefined),
  };
  const renderRunner = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TutorialHostProvider apiBase={BASE}>
          <TutorialRunner script={script} steps={{ point: () => null, prompt: () => null }} transport={transport} />
        </TutorialHostProvider>
      </QueryClientProvider>
    );

  it('hides the chips while a step is live and brings them back when the module ends', () => {
    renderRunner();
    expect(chips.some(hidden)).toBe(false);
    act(() => useTutorialStore.getState().begin({ moduleId: 'demo', sessionId: 's1', stepId: 'intro' }));
    expect(chips.every(hidden)).toBe(true);
    act(() => useTutorialStore.getState().end());
    expect(chips.some(hidden)).toBe(false);
  });
});
