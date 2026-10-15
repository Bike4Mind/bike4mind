// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatMessage } from '@shared/chat';
import type { SkillSource } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageThread } from './MessageThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
        <MessageThread
          messages={[message]}
          sessionId="s1"
          streaming={false}
          onRespond={() => undefined}
          onContinue={() => undefined}
        />
      )
    );

  it('names an account skill as a Bike4Mind skill beside the invocation', () => {
    render(skillTurn('account'));

    expect(container.querySelector('[data-testid="chat-message-skill"]')?.textContent).toBe(
      '/web-summary the release notes'
    );
    expect(container.textContent).toContain('Bike4Mind skill');
  });

  it('keeps a project skill labelled as the repository\'s own', () => {
    render(skillTurn('project'));

    expect(container.textContent).toContain('Project skill');
    expect(container.textContent).not.toContain('Bike4Mind');
  });
});
