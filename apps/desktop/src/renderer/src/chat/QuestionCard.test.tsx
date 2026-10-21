// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatQuestion, ChatQuestionAnswer } from '@shared/questions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionCard } from './QuestionCard';

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

const QUESTIONS: ChatQuestion[] = [
  {
    question: 'Which auth method?',
    header: 'Auth',
    options: [
      { label: 'OAuth (Recommended)', description: 'Delegated sign-in.' },
      { label: 'API keys', description: 'Static secrets.' },
    ],
  },
  {
    question: 'Which checks?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'Unit', description: 'Fast.' },
      { label: 'E2E', description: 'Slow.' },
    ],
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(questions = QUESTIONS) {
  const onSubmit = vi.fn<(answers: ChatQuestionAnswer[]) => void>();
  const onSkip = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <QuestionCard questions={questions} onSubmit={onSubmit} onSkip={onSkip} />
      </CssVarsProvider>
    );
  });
  return { onSubmit, onSkip };
}

const el = (testId: string) => {
  const found = host?.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found as HTMLElement;
};
const click = (testId: string) => act(() => el(testId).click());
const checked = (testId: string) => el(testId).getAttribute('aria-checked') === 'true';
const key = (testId: string, value: string) =>
  act(() => {
    el(testId).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
function typeInto(testId: string, text: string) {
  const input = el(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = () => el('chat-question-submit') as HTMLButtonElement;

describe('QuestionCard', () => {
  it('shows each question with its header, options and descriptions', () => {
    mount();
    expect(host?.textContent).toContain('Which auth method?');
    expect(el('chat-question-header-0').textContent).toBe('Auth');
    expect(el('chat-question-option-0-1').textContent).toContain('Static secrets.');
    expect(el('chat-question-other-0').textContent).toContain('Other');
  });

  it('selects one option at a time on a single-select question', () => {
    mount();
    click('chat-question-option-0-0');
    click('chat-question-option-0-1');
    expect(checked('chat-question-option-0-0')).toBe(false);
    expect(checked('chat-question-option-0-1')).toBe(true);
  });

  it('toggles options on a multi-select question', () => {
    mount();
    click('chat-question-option-1-0');
    click('chat-question-option-1-1');
    expect(checked('chat-question-option-1-0') && checked('chat-question-option-1-1')).toBe(true);
    click('chat-question-option-1-0');
    expect(checked('chat-question-option-1-0')).toBe(false);
  });

  it('keeps Submit disabled until every question is answered, then sends the answers', () => {
    const { onSubmit } = mount();
    click('chat-question-option-0-0');
    expect(submit().disabled).toBe(true);
    click('chat-question-option-1-0');
    click('chat-question-option-1-1');
    expect(submit().disabled).toBe(false);

    click('chat-question-submit');
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ['OAuth (Recommended)'] }, { selected: ['Unit', 'E2E'] }]);
  });

  it('answers with typed Other text, which replaces a single-select pick', () => {
    const { onSubmit } = mount([QUESTIONS[0]]);
    click('chat-question-option-0-0');
    typeInto('chat-question-other-input-0', ' mTLS ');
    expect(checked('chat-question-option-0-0')).toBe(false);
    expect(checked('chat-question-other-0')).toBe(true);

    click('chat-question-submit');
    expect(onSubmit).toHaveBeenCalledWith([{ selected: [], other: 'mTLS' }]);
  });

  it('does not count an empty Other row as an answer', () => {
    mount([QUESTIONS[0]]);
    click('chat-question-other-0');
    expect(submit().disabled).toBe(true);
  });

  it('skips', () => {
    const { onSkip, onSubmit } = mount();
    click('chat-question-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('picks options with the number keys, moving on to the next unanswered question', () => {
    mount();
    key('chat-question-card', '2');
    expect(checked('chat-question-option-0-1')).toBe(true);
    expect(el('chat-question-1').getAttribute('data-active')).toBe('true');

    key('chat-question-card', '1');
    key('chat-question-card', '2');
    expect(checked('chat-question-option-1-0') && checked('chat-question-option-1-1')).toBe(true);
  });

  it('reaches the Other row as the number after the last option', () => {
    mount([QUESTIONS[0]]);
    key('chat-question-card', '3');
    expect(checked('chat-question-other-0')).toBe(true);
  });

  it('submits on Enter once complete, and not before', () => {
    const { onSubmit } = mount([QUESTIONS[0]]);
    key('chat-question-card', 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();

    key('chat-question-card', '1');
    key('chat-question-card', 'Enter');
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ['OAuth (Recommended)'] }]);
  });

  it('leaves number keys typed into the Other field alone', () => {
    mount([QUESTIONS[0]]);
    key('chat-question-other-input-0', '1');
    expect(checked('chat-question-option-0-0')).toBe(false);
  });
});
