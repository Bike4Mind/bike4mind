// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatAttachment, ChatMessage } from '@shared/chat';
import { formatModelEditNote } from '@shared/modelEdit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';

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
