// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type ChatAttachment, type ChatMessage, type ChatToolCall, RUN_BUDGET_STOP } from '@shared/chat';
import { formatModelEditNote } from '@shared/modelEdit';
import type { SkillSource } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitingApprovalKey, budgetPausedReplyIndex, MessageThread } from './MessageThread';
import { QuoteChip } from './QuoteChip';
import { REGENERATE_WARNING_TEXT, REWIND_WARNING_TEXT } from './RewindControls';
import { SessionOpenerContext } from './SessionLink';
import { findShortcut } from './useThreadFind';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

describe('budgetPausedReplyIndex', () => {
  const at = '2026-11-25T00:00:00.000Z';
  const prompt: ChatMessage = { id: 'u', role: 'user', content: 'Plan it', createdAt: at };
  const paused: ChatMessage = { id: 'a', role: 'assistant', content: '', createdAt: at, stopReason: RUN_BUDGET_STOP };
  const report: ChatMessage = { id: 'r', role: 'user', content: 'Agent finished', createdAt: at, system: true };

  it('keeps the raise on a paused reply that only app notices followed', () => {
    expect(budgetPausedReplyIndex([prompt, paused])).toBe(1);
    expect(budgetPausedReplyIndex([prompt, paused, report, report])).toBe(1);
  });

  it('offers nothing once the user typed after it, or when the last reply was not paused', () => {
    expect(budgetPausedReplyIndex([prompt, paused, prompt])).toBe(-1);
    expect(budgetPausedReplyIndex([prompt, { ...paused, stopReason: undefined }, report])).toBe(-1);
    expect(budgetPausedReplyIndex([report])).toBe(-1);
  });
});

describe('awaiting a prompt', () => {
  const call = (overrides: Partial<ChatToolCall> = {}): ChatToolCall => ({
    id: 'c1',
    name: 'bash',
    input: { command: 'rm -rf build' },
    status: 'running',
    ...overrides,
  });

  const reply = (toolCalls: ChatToolCall[]): ChatMessage => ({
    id: 'a1',
    role: 'assistant',
    content: 'Cleaning up.',
    createdAt: new Date().toISOString(),
    toolCalls,
  });

  describe('awaitingApprovalKey', () => {
    it('is empty with nothing to answer', () => {
      expect(awaitingApprovalKey(undefined)).toBe('');
      expect(awaitingApprovalKey(reply([call()]))).toBe('');
    });

    it('names each prompt the message is parked on', () => {
      const message = reply([
        call({ id: 'c1', status: 'awaiting-approval', approvalId: 'p1' }),
        call({ id: 'c2', status: 'done' }),
        call({ id: 'c3', status: 'awaiting-approval', approvalId: 'p3' }),
      ]);
      expect(awaitingApprovalKey(message)).toBe('["p1","p3"]');
    });

    it('tells apart ids that would collide once joined', () => {
      const one = reply([call({ status: 'awaiting-approval', approvalId: 'a,b' })]);
      const two = reply([
        call({ id: 'c1', status: 'awaiting-approval', approvalId: 'a' }),
        call({ id: 'c2', status: 'awaiting-approval', approvalId: 'b' }),
      ]);
      expect(awaitingApprovalKey(one)).not.toBe(awaitingApprovalKey(two));
    });
  });

  describe('a prompt arriving in the thread', () => {
    let container: HTMLDivElement;
    let root: Root;
    const scrollIntoView = vi.fn();

    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    const render = (message: ChatMessage) =>
      act(() =>
        root.render(
          <CssVarsProvider>
            <MessageThread
              messages={[message]}
              sessionId="s1"
              streaming
              onRespond={() => undefined}
              onContinue={() => undefined}
            />
          </CssVarsProvider>
        )
      );

    /** The reader scrolls well up from the bottom, which unpins the thread from following. */
    const scrollUp = () => {
      const host = container.querySelector<HTMLElement>('[data-testid="chat-thread"]');
      if (!host) throw new Error('thread did not render');
      Object.defineProperty(host, 'scrollHeight', { configurable: true, value: 5000 });
      Object.defineProperty(host, 'clientHeight', { configurable: true, value: 800 });
      host.scrollTop = 1000;
      act(() => {
        host.dispatchEvent(new Event('scroll'));
      });
    };

    it('is brought into view even when the reader had scrolled up', () => {
      render(reply([call()]));
      scrollUp();
      scrollIntoView.mockClear();

      // Same message, same number of calls: only the status changes.
      render(reply([call({ status: 'awaiting-approval', approvalId: 'p1' })]));

      expect(container.querySelector('[data-testid="chat-tool-approval"]')).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
    });

    it('leaves a scrolled-up reader alone while nothing new is asked', () => {
      render(reply([call()]));
      scrollUp();
      scrollIntoView.mockClear();

      render(reply([call({ preview: 'still going' })]));

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});

function image(name: string): ChatAttachment {
  return { id: name, kind: 'image', name, mediaType: 'image/png', size: 10 } as unknown as ChatAttachment;
}

const NOTE = formatModelEditNote({
  path: '/work/lantern.model.js',
  units: 'mm',
  parts: [{ name: 'cap', lines: [12], min: [0, 0, 0], max: [1, 1, 1] }],
  sharedLines: [],
  closeup: 'model-edit-cap.png',
});

describe('a point-and-edit turn in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (message: ChatMessage) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={[message]}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
          />
        </CssVarsProvider>
      )
    );

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it('shows the typed words with an Editing chip, and keeps the note and close-up out of the bubble', () => {
    render({
      id: 'm1',
      role: 'user',
      content: 'make this brass',
      createdAt: new Date().toISOString(),
      notes: [NOTE],
      attachments: [image('model-edit-cap.png')],
    });
    expect(byTestId('chat-message-model-edit-chip')?.textContent).toBe('Editing: cap');
    expect(byTestId('chat-message-user-text')?.textContent).toBe('make this brass');
    expect(byTestId('chat-message-user')?.textContent).not.toContain('Point-and-edit');
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws no chip on an ordinary turn', () => {
    render({ id: 'm2', role: 'user', content: 'hello', createdAt: new Date().toISOString() });
    expect(byTestId('chat-message-model-edit-chip')).toBeNull();
  });
});

/** A user turn that ran a skill: the thread draws the invocation and a chip naming its source. */
function skillTurn(source: SkillSource): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'Summarise the release notes.',
    createdAt: new Date().toISOString(),
    skill: { name: 'web-summary', args: 'the release notes', source },
  };
}

describe('a skill turn in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (message: ChatMessage) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <MessageThread
            messages={[message]}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
          />
        </CssVarsProvider>
      )
    );

  const chip = () => container.querySelector<HTMLElement>('[data-testid="chat-message-skill-chip"]');

  it('names an account skill as a Bike4Mind skill beside the invocation', () => {
    render(skillTurn('account'));

    expect(container.querySelector('[data-testid="chat-message-skill"]')?.textContent).toBe(
      '/web-summary the release notes'
    );
    expect(chip()?.textContent).toBe('Bike4Mind skill');
    // The colour is the only place the account's "yours, from the web" origin reads at a glance.
    expect(chip()?.className).toContain('MuiChip-colorPrimary');
  });

  it("keeps a project skill labelled as the repository's own", () => {
    render(skillTurn('project'));

    expect(chip()?.textContent).toBe('Project skill');
    expect(chip()?.className).toContain('MuiChip-colorWarning');
    expect(container.textContent).not.toContain('Bike4Mind');
  });
});

const TARGET = '33333333-3333-4333-8333-333333333333';

describe('relay rows and session mentions in the thread', () => {
  let container: HTMLDivElement;
  let root: Root;
  let open: ReturnType<typeof vi.fn<(id: string) => void>>;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    open = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (message: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <SessionOpenerContext.Provider value={open}>
            <MessageThread
              messages={[{ id: 'm1', createdAt: new Date().toISOString(), ...message }]}
              sessionId="s1"
              streaming={false}
              onRespond={() => undefined}
              onContinue={() => undefined}
            />
          </SessionOpenerContext.Provider>
        </CssVarsProvider>
      )
    );

  const byId = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('opens the sender from the relay row without toggling the disclosure', () => {
    render({
      role: 'user',
      content: 'please check',
      relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', fromProject: 'docs', hops: 1 },
    });
    expect(byId('chat-message-relay-summary')?.textContent).toContain('Received message from Docs pass (docs)');

    const details = byId('chat-message-relay') as HTMLDetailsElement;
    const link = byId('relay-sender-link');
    let defaultPrevented = false;
    act(() => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
    });
    expect(open).toHaveBeenCalledWith('sender-1');
    expect(defaultPrevented).toBe(true);
    expect(details.open).toBe(false);
  });

  it('reads a done notice as the sender finishing', () => {
    render({
      role: 'user',
      content: 'app text',
      relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', hops: 1, kind: 'done' },
    });
    expect(byId('chat-message-relay-summary')?.textContent).toBe('Docs pass finished the turn your message started');
  });

  it('draws a mention in a user message as a link to that session', () => {
    render({ role: 'user', content: `look at @[Docs pass](session:${TARGET}) please` });
    const link = byId('session-mention-link');
    expect(link?.textContent).toBe('@Docs pass');
    expect(byId('chat-message-user-text')?.textContent).toBe('look at @Docs pass please');
    act(() => link?.click());
    expect(open).toHaveBeenCalledWith(TARGET);
  });
});

describe('side chats', () => {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(100, 200, 80, 16);

  const at = '2026-11-06T00:00:00.000Z';

  const opening: ChatMessage = {
    id: 'o1',
    role: 'user',
    content: 'model copy with the parent excerpt',
    display: '> the highlighted passage',
    system: true,
    sideChatOf: { sessionId: 'parent-1', title: 'Monads' },
    createdAt: at,
  };

  const reply: ChatMessage = { id: 'a1', role: 'assistant', content: 'A monad is a monoid.', createdAt: at };

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getSelection()?.removeAllRanges();
  });

  const find = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  describe('a side chat in the thread', () => {
    it('opens with where it branched from, linked back, and the passage instead of the model copy', () => {
      const open = vi.fn();
      act(() =>
        root.render(
          <CssVarsProvider>
            <SessionOpenerContext.Provider value={open}>
              <MessageThread
                messages={[opening]}
                sessionId="child-1"
                streaming={false}
                onRespond={() => undefined}
                onContinue={() => undefined}
              />
            </SessionOpenerContext.Provider>
          </CssVarsProvider>
        )
      );
      const note = find('chat-message-side-chat-opening')!;
      expect(note.textContent).toContain('Side chat from');
      expect(note.textContent).toContain('the highlighted passage');
      expect(note.textContent).not.toContain('parent excerpt');
      act(() => find('side-chat-parent-link')!.click());
      expect(open).toHaveBeenCalledWith('parent-1');
    });

    it('offers the selection actions over a reply and passes the highlight to Reply', () => {
      const onReply = vi.fn();
      const onSideChat = vi.fn();
      act(() =>
        root.render(
          <CssVarsProvider>
            <MessageThread
              messages={[reply]}
              sessionId="s1"
              streaming={false}
              onRespond={() => undefined}
              onContinue={() => undefined}
              onReplyToSelection={onReply}
              onSideChatFromSelection={onSideChat}
            />
          </CssVarsProvider>
        )
      );
      const text = find('chat-markdown')!.querySelector('p')!.firstChild!;
      act(() => {
        document.getSelection()!.setBaseAndExtent(text, 2, text, 7);
        document.dispatchEvent(new Event('selectionchange'));
      });
      act(() => find('selection-actions-reply-btn')!.click());
      expect(onReply).toHaveBeenCalledWith('monad');
    });
  });

  describe('QuoteChip', () => {
    it('shows the quote and removes it on request', () => {
      const onRemove = vi.fn();
      act(() =>
        root.render(
          <CssVarsProvider>
            <QuoteChip quote="the passage" onRemove={onRemove} />
          </CssVarsProvider>
        )
      );
      expect(find('composer-quote-text')!.textContent).toBe('the passage');
      const remove = find('composer-quote-remove-btn')!;
      expect(remove.getAttribute('aria-label')).toBe('Remove quote');
      act(() => remove.click());
      expect(onRemove).toHaveBeenCalledOnce();
    });
  });
});

describe('find', () => {
  const at = '2026-11-01T00:00:00.000Z';

  const thread: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'where is the needle?', createdAt: at },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      createdAt: at,
      rounds: [
        { text: 'Let me look.', toolCallIds: ['c1'] },
        { text: 'Found the needle.', toolCallIds: [] },
      ],
      toolCalls: [
        {
          id: 'c1',
          name: 'bash_execute',
          input: { command: 'cat haystack.txt' },
          status: 'done',
          preview: `${'hay\n'.repeat(80)}needle\n`,
        },
      ],
    },
    {
      id: 'r1',
      role: 'user',
      content: 'a relayed needle',
      relay: { fromSessionId: 's2', fromTitle: 'Other', hops: 1 },
      createdAt: at,
    },
  ];

  describe('find in the open conversation', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      Element.prototype.scrollIntoView = () => undefined;
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    const render = (findable = true, messages = thread) =>
      act(() =>
        root.render(
          <CssVarsProvider>
            <MessageThread
              messages={messages}
              sessionId="s1"
              streaming={false}
              onRespond={() => undefined}
              onContinue={() => undefined}
              findable={findable}
            />
          </CssVarsProvider>
        )
      );

    const one = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    // Both modifiers, so the chord is Mod+key whichever platform the test DOM reports.
    const chord = (key: string, init: KeyboardEventInit = {}) =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true, ...init })
        );
      });
    const inInput = (key: string, init: KeyboardEventInit = {}) =>
      act(() => {
        one('chat-find-input')!.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        );
      });
    const type = (text: string) => {
      const input = one('chat-find-input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const toolRow = () => one('chat-tool-row') as HTMLDetailsElement;
    const relay = () => one('chat-message-relay') as HTMLDetailsElement;

    it('opens on Mod+F with the input focused, and counts matches in collapsed and clipped content', () => {
      render();
      expect(one('chat-find-bar')).toBeNull();
      chord('f');
      expect(one('chat-find-bar')).not.toBeNull();
      expect(document.activeElement).toBe(one('chat-find-input'));

      type('NEEDLE');
      // User text, the tool's output, the second round, the relay: the last is current.
      expect(one('chat-find-count')?.textContent).toBe('4 of 4');
      expect(relay().open).toBe(true);
      expect(toolRow().open).toBe(false);
    });

    it('cycles with Enter, Shift+Enter and Mod+G, opening the tool row and expanding its clipped output', () => {
      render();
      chord('f');
      type('needle');

      inInput('Enter', { shiftKey: true });
      expect(one('chat-find-count')?.textContent).toBe('3 of 4');
      inInput('Enter', { shiftKey: true });
      expect(one('chat-find-count')?.textContent).toBe('2 of 4');
      expect(toolRow().open).toBe(true);
      expect(one('chat-tool-detail-output-clip')?.dataset.expanded).toBe('true');

      chord('g');
      expect(one('chat-find-count')?.textContent).toBe('3 of 4');
      chord('G', { shiftKey: true });
      chord('G', { shiftKey: true });
      expect(one('chat-find-count')?.textContent).toBe('1 of 4');
      inInput('Enter', { shiftKey: true });
      expect(one('chat-find-count')?.textContent).toBe('4 of 4');
      inInput('Enter');
      expect(one('chat-find-count')?.textContent).toBe('1 of 4');
    });

    it('honours the case toggle', () => {
      render();
      chord('f');
      type('Found');
      expect(one('chat-find-count')?.textContent).toBe('1 of 1');
      act(() => one('chat-find-case-toggle')!.click());
      type('found');
      expect(one('chat-find-count')?.textContent).toBe('No results');
      expect(one('chat-find-case-toggle')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('closes on Escape and leaves what it opened open', () => {
      render();
      chord('f');
      type('needle');
      inInput('Escape');
      expect(one('chat-find-bar')).toBeNull();
      expect(relay().open).toBe(true);
    });

    it('opens the section folded above a /clear when the match is in it', () => {
      render(true, [
        { id: 'old', role: 'user', content: 'an old needle', createdAt: at },
        { id: 'cut', role: 'assistant', content: '', boundary: { kind: 'clear' }, createdAt: at },
        { id: 'new', role: 'user', content: 'something else', createdAt: at },
      ]);
      const earlier = one('chat-earlier-messages') as HTMLDetailsElement;
      expect(earlier.open).toBe(false);
      chord('f');
      type('needle');
      expect(one('chat-find-count')?.textContent).toBe('1 of 1');
      expect(earlier.open).toBe(true);
      expect(container.querySelector('[data-find-scope="message:old"]')?.textContent).toBe('an old needle');
    });

    it('is not bound on a thread that is not findable', () => {
      render(false);
      chord('f');
      expect(one('chat-find-bar')).toBeNull();
    });
  });

  describe('findShortcut', () => {
    const key = (k: string, init: Partial<KeyboardEvent> = {}) => ({
      key: k,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });

    it('maps Cmd on a Mac and Ctrl elsewhere', () => {
      expect(findShortcut(key('f', { metaKey: true }), true)).toBe('open');
      expect(findShortcut(key('f', { ctrlKey: true }), true)).toBeNull();
      expect(findShortcut(key('f', { ctrlKey: true }), false)).toBe('open');
      expect(findShortcut(key('g', { metaKey: true }), true)).toBe('next');
      expect(findShortcut(key('G', { metaKey: true, shiftKey: true }), true)).toBe('previous');
    });

    it('leaves Mod+Shift+F (sidebar search) and Alt chords alone', () => {
      expect(findShortcut(key('F', { metaKey: true, shiftKey: true }), true)).toBeNull();
      expect(findShortcut(key('f', { metaKey: true, altKey: true }), true)).toBeNull();
      expect(findShortcut(key('f'), true)).toBeNull();
    });
  });
});

describe('rewind', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const user = (id: string, content = id): ChatMessage => ({ id, role: 'user', content, createdAt: at });
  const reply = (id: string, calls: Pick<ChatToolCall, 'name' | 'status'>[] = []): ChatMessage => ({
    id,
    role: 'assistant',
    content: `reply ${id}`,
    createdAt: at,
    ...(calls.length ? { toolCalls: calls.map((call, index) => ({ id: `${id}-${index}`, input: {}, ...call })) } : {}),
  });

  describe('edit and regenerate in the thread', () => {
    let container: HTMLDivElement;
    let root: Root;
    const onEditMessage = vi.fn<(messageId: string, text: string) => Promise<boolean>>();
    const onRegenerate = vi.fn();

    beforeEach(() => {
      Element.prototype.scrollIntoView = () => undefined;
      onEditMessage.mockReset().mockResolvedValue(true);
      onRegenerate.mockReset();
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    const render = (messages: ChatMessage[], streaming = false) =>
      act(() =>
        root.render(
          <CssVarsProvider>
            <MessageThread
              messages={messages}
              sessionId="s1"
              streaming={streaming}
              onRespond={() => undefined}
              onContinue={() => undefined}
              onEditMessage={onEditMessage}
              onRegenerate={onRegenerate}
            />
          </CssVarsProvider>
        )
      );

    const all = (testId: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
    const one = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const click = (element: HTMLElement | null) => act(() => element?.click());
    const type = (text: string) => {
      const input = one('chat-message-user-editor-input') as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      act(() => {
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const press = (key: string) =>
      act(() => {
        one('chat-message-user-editor-input')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });

    it('opens an inline editor with the prompt, and sends the edit for that message', async () => {
      render([user('u1', 'first'), reply('a1')]);
      click(all('chat-message-user-edit-btn')[0]);
      expect((one('chat-message-user-editor-input') as HTMLTextAreaElement).value).toBe('first');

      type('first, edited');
      await act(async () => one('chat-message-user-editor-send-btn')!.click());
      expect(onEditMessage).toHaveBeenCalledWith('u1', 'first, edited');
    });

    it('cancels with Escape and leaves the message as it was', () => {
      render([user('u1', 'first'), reply('a1')]);
      click(all('chat-message-user-edit-btn')[0]);
      type('changed my mind');
      press('Escape');
      expect(one('chat-message-user-editor')).toBeNull();
      expect(onEditMessage).not.toHaveBeenCalled();
    });

    it('warns that files are not restored only when a later turn changed them', () => {
      render([
        user('u1'),
        reply('a1', [{ name: 'file_write', status: 'done' }]),
        user('u2'),
        reply('a2', [{ name: 'grep_search', status: 'done' }]),
      ]);
      const [first, second] = all('chat-message-user-edit-btn');

      click(first);
      expect(one('chat-message-user-editor-warning')?.textContent).toBe(REWIND_WARNING_TEXT.changes);
      press('Escape');

      click(second);
      expect(one('chat-message-user-editor-warning')?.textContent).toBe(REWIND_WARNING_TEXT.later);
    });

    it('disables Edit and hides Regenerate while a turn is running', () => {
      render([user('u1'), reply('a1'), user('u2')], true);
      expect(all('chat-message-user-edit-btn').every(button => button.hasAttribute('disabled'))).toBe(true);
      expect(one('chat-message-assistant-regenerate-btn')).toBeNull();
    });

    it('offers no Edit on a prompt that is not stored yet', () => {
      render([user('pending-123')]);
      expect(one('chat-message-user-edit-btn')).toBeNull();
    });

    it('offers Regenerate on the last reply only, and runs it at once when nothing changed', () => {
      render([user('u1'), reply('a1'), user('u2'), reply('a2')]);
      expect(all('chat-message-assistant-regenerate-btn')).toHaveLength(1);
      click(one('chat-message-assistant-regenerate-btn'));
      expect(onRegenerate).toHaveBeenCalledTimes(1);
    });

    it('asks first when the reply being replaced changed files', () => {
      render([user('u1'), reply('a1', [{ name: 'bash_execute', status: 'done' }])]);
      click(one('chat-message-assistant-regenerate-btn'));
      expect(onRegenerate).not.toHaveBeenCalled();
      expect(one('chat-message-assistant-regenerate-confirm')?.textContent).toContain(REGENERATE_WARNING_TEXT);
      click(one('chat-message-assistant-regenerate-confirm-btn'));
      expect(onRegenerate).toHaveBeenCalledTimes(1);
    });
  });
});

describe('message actions', () => {
  const at = '2026-10-22T00:00:00.000Z';

  const prompt: ChatMessage = {
    id: 'u1',
    role: 'user',
    content: 'Why does https://example.com/a_b. fail (see https://example.com/c)?',
    createdAt: at,
  };

  const reply: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: 'It redirects to https://example.com/login.\n\nSee [the docs](https://docs.example.com) too.',
    createdAt: at,
  };

  describe('links and copy in the thread', () => {
    let container: HTMLDivElement;
    let root: Root;
    const openExternal = vi.fn(async () => undefined);
    const writeText = vi.fn<(text: string) => Promise<void>>();

    beforeEach(() => {
      Element.prototype.scrollIntoView = () => undefined;
      openExternal.mockClear();
      writeText.mockReset().mockResolvedValue(undefined);
      vi.stubGlobal('b4m', { shell: { openExternal } });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const render = (messages: ChatMessage[], streaming = false) =>
      act(() =>
        root.render(
          <CssVarsProvider>
            <MessageThread
              messages={messages}
              sessionId="s1"
              streaming={streaming}
              onRespond={() => undefined}
              onContinue={() => undefined}
            />
          </CssVarsProvider>
        )
      );

    const within = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    const hrefs = (scope: HTMLElement, linkTestId: string) =>
      [...scope.querySelectorAll(`[data-testid="${linkTestId}"]`)].map(anchor => anchor.getAttribute('href'));

    it.each([
      [20, 'just now'],
      [60, '1 minute ago'],
      [120, '2 minutes ago'],
      [3600, '1 hour ago'],
      [7200, '2 hours ago'],
      [86400, '1 day ago'],
      [604800, '1 week ago'],
      [2592000, '1 month ago'],
      [31536000, '1 year ago'],
      [-60, 'just now'],
    ])('shows %s seconds of message age as "%s" on hover', (seconds, expected) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at) + seconds * 1000);
      render([prompt, reply]);

      for (const role of ['user', 'assistant']) {
        const message = within(`chat-message-${role}`);
        act(() => message.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(message.title).toBe(expected);
      }
    });

    it('refreshes the relative time when hovering again without a rerender', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at) + 120_000);
      render([prompt, reply]);

      for (const role of ['user', 'assistant']) {
        now.mockReturnValue(Date.parse(at) + 120_000);
        const message = within(`chat-message-${role}`);
        act(() => message.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(message.title).toBe('2 minutes ago');
        act(() => message.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
        now.mockReturnValue(Date.parse(at) + 180_000);
        act(() => message.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(message.title).toBe('3 minutes ago');
      }
    });

    it('does not show an invalid timestamp on hover', () => {
      render([
        { ...prompt, createdAt: 'invalid' },
        { ...reply, createdAt: 'invalid' },
      ]);

      for (const role of ['user', 'assistant']) {
        const message = within(`chat-message-${role}`);
        act(() => message.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(message.title).toBe('');
      }
    });

    it('links the urls in a prompt without rendering the prompt as markdown', () => {
      render([prompt]);

      const user = within('chat-message-user');
      expect(hrefs(user, 'chat-message-link')).toEqual(['https://example.com/a_b', 'https://example.com/c']);
      // Still literal: nothing parsed the underscore or the parentheses as markup.
      expect(within('chat-message-user-text').textContent).toBe(prompt.content);
    });

    it('links a bare url in a reply as well as a written-out one', () => {
      render([prompt, reply]);

      expect(hrefs(within('chat-message-assistant'), 'chat-markdown-link')).toEqual([
        'https://example.com/login',
        'https://docs.example.com',
      ]);
    });

    it('opens a link from either side in the system browser', () => {
      render([prompt, reply]);

      act(() => within('chat-message-user').querySelector<HTMLAnchorElement>('a')!.click());
      act(() => within('chat-message-assistant').querySelector<HTMLAnchorElement>('a')!.click());

      expect(openExternal.mock.calls).toEqual([['https://example.com/a_b'], ['https://example.com/login']]);
    });

    it('copies the prompt as typed and the reply as its markdown source', async () => {
      render([prompt, reply]);

      await act(async () => within('chat-message-user-copy-btn').click());
      await act(async () => within('chat-message-assistant-copy-btn').click());

      expect(writeText.mock.calls).toEqual([[prompt.content], [reply.content]]);
      expect(within('chat-message-user-copy-btn').dataset.state).toBe('copied');
      expect(within('chat-message-assistant-copy-btn').dataset.state).toBe('copied');
    });

    it('copies the invocation on a skill turn, not the body it expanded to', async () => {
      render([
        {
          ...prompt,
          content: 'A page of skill instructions.',
          skill: { name: 'summary', args: 'notes', source: 'project' },
        },
      ]);

      await act(async () => within('chat-message-user-copy-btn').click());

      expect(writeText).toHaveBeenCalledExactlyOnceWith('/summary notes');
    });

    it('offers no copy on a reply that is still being written', () => {
      render([prompt, reply], true);

      expect(within('chat-message-user-copy-btn')).not.toBeNull();
      expect(within('chat-message-assistant-copy-btn')).toBeNull();
    });

    it('offers no copy on a turn with no text, or on a notice the app wrote', () => {
      render([
        { ...reply, id: 'a0', content: '' },
        { id: 's1', role: 'user', system: true, content: 'Done: https://example.com/pr/1', createdAt: at },
      ]);

      expect(container.querySelector('[data-testid$="-copy-btn"]')).toBeNull();
      // The notice's url is still a link.
      expect(hrefs(within('chat-message-system'), 'chat-message-link')).toEqual(['https://example.com/pr/1']);
    });
  });
});
