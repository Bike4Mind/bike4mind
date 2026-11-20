import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentModeCue } from './agentMode';
import type { TutorialStepProps } from './types';

const cueState = vi.hoisted(() => ({ cue: null as AgentModeCue | null }));
vi.mock('./agentMode', () => ({ useAgentModeCue: () => cueState.cue }));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useWorkBenchFiles: () => [] }));
const composer = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    chatInputValue: '',
    setDraft: (() => undefined) as (sessionId: string, value: string) => void,
    setChatInputValue: (value: string) => {
      state.chatInputValue = value;
      listeners.forEach(listener => listener());
    },
    requestFocus: () => undefined,
    clearDraft: (() => undefined) as (sessionId: string) => void,
  };
  return { state, listeners };
});
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: {
    getState: () => composer.state,
    subscribe: (listener: () => void) => {
      composer.listeners.add(listener);
      return () => composer.listeners.delete(listener);
    },
  },
}));

import { AttachStep, PromptStep } from './genericSteps';

const renderPrompt = (setAnchor: TutorialStepProps['setAnchor']) =>
  render(
    <PromptStep
      {...({
        step: { id: 'send', type: 'prompt', turn: 1, prompt: 'Send this', anchor: 'send-message-btn' },
        sessionId: 's1',
        quests: [],
        complete: vi.fn(),
        setAnchor,
      } as unknown as TutorialStepProps)}
    />
  );

describe('PromptStep', () => {
  beforeEach(() => {
    cueState.cue = null;
  });

  it('searches the whole page for a cue control, outside the step scope', () => {
    cueState.cue = { anchor: 'attach-menu-agent-mode-switch', hint: 'Turn agent mode off' };
    const setAnchor = vi.fn();
    renderPrompt(setAnchor);
    expect(setAnchor).toHaveBeenLastCalledWith('attach-menu-agent-mode-switch', { scope: undefined });
    expect('scope' in setAnchor.mock.lastCall![1]).toBe(true);
  });

  it('keeps the step anchor and its scope with no cue', () => {
    const setAnchor = vi.fn();
    renderPrompt(setAnchor);
    expect(setAnchor).toHaveBeenLastCalledWith(undefined, undefined);
  });
});

describe('PromptStep once its turn is sent', () => {
  const PROMPT = 'Send this';
  const renderSent = () =>
    render(
      <PromptStep
        {...({
          step: { id: 'send', type: 'prompt', turn: 0, prompt: PROMPT },
          sessionId: 's1',
          quests: [{ id: 'q1', prompt: PROMPT, status: 'running' }],
          complete: vi.fn(),
          setAnchor: vi.fn(),
        } as unknown as TutorialStepProps)}
      />
    );

  beforeEach(() => {
    cueState.cue = null;
    composer.listeners.clear();
    composer.state.chatInputValue = '';
    composer.state.clearDraft = vi.fn();
  });

  it('empties the composer and its saved draft when it still holds the sent prompt', () => {
    composer.state.chatInputValue = 'send  THIS';
    renderSent();
    expect(composer.state.chatInputValue).toBe('');
    expect(composer.state.clearDraft).toHaveBeenCalledWith('s1');
  });

  it('empties it again when a draft restore puts the sent prompt back', () => {
    renderSent();
    act(() => composer.state.setChatInputValue(PROMPT));
    expect(composer.state.chatInputValue).toBe('');
  });

  it('leaves text the user typed', () => {
    renderSent();
    act(() => composer.state.setChatInputValue('my own question'));
    expect(composer.state.chatInputValue).toBe('my own question');
    expect(composer.state.clearDraft).not.toHaveBeenCalled();
  });

  it('stops watching once the step is gone', () => {
    const { unmount } = renderSent();
    unmount();
    expect(composer.listeners.size).toBe(0);
  });
});

describe('AttachStep', () => {
  // Core's testids, written out rather than read from BULK_FILE_ACTIONS, so dropping or misspelling one fails.
  const CORE_BULK_ACTIONS = [
    'file-browser-delete-btn',
    'file-browser-share-btn',
    'file-browser-tag-menu-btn',
    'file-browser-lake-menu-btn',
    'file-browser-select-all-btn',
  ];
  const renderAttach = (sheetFileId: () => Promise<string> = () => new Promise<string>(() => undefined)) =>
    render(
      <AttachStep
        {...({
          step: { id: 'attach', type: 'attach', anchor: 'attach-files-btn', params: { fileName: 'sheet.csv' } },
          sessionId: 's1',
          quests: [],
          complete: vi.fn(),
          setAnchor: vi.fn(),
          sheetFileId,
        } as unknown as TutorialStepProps)}
      />
    );
  const mountTestid = (testid: string, parent: HTMLElement = document.body) => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', testid);
    parent.appendChild(el);
    return el;
  };
  const hidden = (el: HTMLElement) => getComputedStyle(el).display === 'none';

  let dialog: HTMLElement;
  let actions: HTMLElement[] = [];
  beforeEach(() => {
    dialog = mountTestid('file-browser-dialog');
    actions = CORE_BULK_ACTIONS.map(testid => mountTestid(testid, dialog));
  });
  afterEach(() => {
    dialog.remove();
    document.querySelectorAll('[data-testid="tutorial-coach-pill"]').forEach(el => el.remove());
  });

  it('hides every bulk file action in the attach dialog while it is mounted, and leaves Add alone', () => {
    const add = mountTestid('file-browser-add-files-btn', dialog);
    renderAttach();
    expect(actions.filter(hidden)).toHaveLength(CORE_BULK_ACTIONS.length);
    expect(hidden(add)).toBe(false);
  });

  it('leaves the bulk actions of a file browser outside the attach dialog alone', () => {
    const elsewhere = mountTestid('file-browser-delete-btn');
    renderAttach();
    expect(hidden(elsewhere)).toBe(false);
    elsewhere.remove();
  });

  it('still hides them when the sheet lookup fails', async () => {
    renderAttach(() => Promise.reject(new Error('503')));
    await screen.findByTestId('tutorial-attach-retry');
    expect(actions.every(hidden)).toBe(true);
  });

  it('brings them back once the step unmounts, as it does on the next step or on leaving', () => {
    const { unmount } = renderAttach();
    unmount();
    expect(actions.some(hidden)).toBe(false);
  });

  it('brings them back while the card is tucked into its step pill', () => {
    renderAttach();
    const pill = mountTestid('tutorial-coach-pill');
    expect(actions.some(hidden)).toBe(false);
    pill.remove();
    expect(actions.every(hidden)).toBe(true);
  });
});
