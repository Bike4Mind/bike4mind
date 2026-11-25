import type { TutorialStep } from '@bike4mind/common';

export const FIRST_STEPS_STEPS: TutorialStep[] = [
  {
    id: 'first-steps-send',
    type: 'prompt',
    turn: 0,
    prompt: 'What can you help me with?',
    anchor: 'send-message-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Send a message',
    body: 'A question is waiting in the message box. Press Send to see how an answer arrives.',
  },
  {
    id: 'first-steps-composer',
    type: 'point',
    anchor: 'session-bottom-container',
    placement: 'above',
    title: 'Ask anything',
    body: 'The answer appears above. Type your own message here whenever you like, in your own words.',
  },
  {
    id: 'first-steps-done',
    type: 'bridge',
    title: 'You are set',
    body: 'That is the basics. Open Tutorials from your account menu or the Help Center any time to take another one.',
    action: 'Done',
  },
];
