import type { TutorialStep } from '@bike4mind/common';

export const SWITCHING_MODELS_STEPS: TutorialStep[] = [
  {
    id: 'switching-models-ask',
    type: 'prompt',
    turn: 0,
    prompt: 'Suggest three names for a neighborhood book club, one line each.',
    anchor: 'send-message-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Ask a question',
    body: 'A question is waiting in the message box. Press Send to get a first answer.',
  },
  {
    id: 'switching-models-switch',
    type: 'model-switch',
    anchor: 'ai-settings-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Switch the model',
    body: 'Press the model button and pick another chat model, even one from another provider. The conversation stays in this notebook.',
    doneBody: 'Pick a different chat model from the list.',
  },
  {
    id: 'switching-models-follow-up',
    type: 'prompt',
    turn: 1,
    prompt: 'Which of those suits a group that mostly reads mysteries? Pick one and say why in two sentences.',
    anchor: 'send-message-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Ask a follow-up',
    body: 'Send this follow-up. After a switch, the new model sees the whole conversation, so you do not need to repeat anything.',
  },
  {
    id: 'switching-models-done',
    type: 'bridge',
    // Keeps the card off the second answer, which shows the context carried across the switch.
    avoid: '[data-testid="virtuoso-item-list"] > :last-child [data-testid="ai-response"]',
    title: 'Pick the model for the job',
    body: 'Use a fast model for quick, everyday asks and a stronger one for hard problems or long documents.',
    action: 'Done',
  },
];
