import type { TutorialStep } from '@bike4mind/common';

const SEND = 'send-message-btn';
const COMPOSER = '[data-testid="session-bottom-container"]';

export const FIRST_STEPS_STEPS: TutorialStep[] = [
  {
    id: 'first-steps-send',
    type: 'prompt',
    turn: 0,
    prompt:
      'Help me write a short, polite email to my landlord asking when the broken heater in my apartment will be fixed.',
    anchor: SEND,
    anchorScope: COMPOSER,
    placement: 'above',
    title: 'Send your first message',
    body: 'A request is waiting in the message box: a short email to a landlord. Press Send to see the assistant draft it.',
  },
  {
    id: 'first-steps-follow-up',
    type: 'prompt',
    turn: 1,
    prompt: 'Good start. Make it a little firmer, and mention that it has been broken for three days.',
    anchor: SEND,
    anchorScope: COMPOSER,
    placement: 'above',
    title: 'Ask a follow-up',
    body: 'You can reply to change an answer. It remembers the conversation, so a short note is enough. Press Send.',
  },
  {
    id: 'first-steps-attach',
    type: 'attach',
    anchor: 'attach-files-btn',
    placement: 'above',
    title: 'Add a file',
    body: 'Answers can use your own files. A sample sheet of monthly spending is waiting in your files. Add it to the chat.',
    doneBody: 'The sheet is attached. Press Next.',
    params: { fileName: 'monthly-spending.csv' },
  },
  {
    id: 'first-steps-ask-file',
    type: 'prompt',
    turn: 2,
    prompt:
      'This is my monthly spending. After rent, which three costs are biggest, and where could I realistically save?',
    anchor: SEND,
    anchorScope: COMPOSER,
    placement: 'above',
    title: 'Ask about the file',
    body: 'Now ask a question about it. The answer is worked out from the numbers in the sheet. Press Send.',
  },
  {
    id: 'first-steps-notebooks',
    type: 'point',
    anchor: 'notebook-list-item',
    placement: 'right',
    // Keeps the card off the answer it is pointing away from; with the chat taken, it settles in the side menu.
    avoid: '[data-testid="virtuoso-item-list"] > :last-child [data-testid="ai-response"]',
    title: 'Your conversations are saved',
    body: 'This conversation is saved as a notebook in the side menu. Open it any time to pick up where you left off.',
  },
  {
    id: 'first-steps-done',
    type: 'bridge',
    title: 'Where to go next',
    body: 'Press New Chat to start your own. In your account menu, Tutorials has short tours of what is different here, and you can get the desktop app.',
    action: 'Done',
  },
];
