import type { TutorialStep } from '@bike4mind/common';

export const ARTIFACTS_STEPS: TutorialStep[] = [
  {
    id: 'artifacts-ask',
    type: 'prompt',
    turn: 0,
    prompt: 'Make a one-page flyer for a plant swap at Willow Lane Community Garden, Saturday 9 to 11am.',
    anchor: 'send-message-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Ask for a page',
    body: 'A request for a flyer is in the message box. Press Send. The flyer comes back as an artifact: a finished page, not just text.',
  },
  {
    id: 'artifacts-open',
    type: 'artifact-open',
    anchor: 'html-artifact-expand-btn',
    placement: 'above',
    title: 'Open it full size',
    body: 'Press the expand button on the flyer. It opens in a viewer alongside the chat, where you can read it, copy it or save it.',
  },
  {
    id: 'artifacts-revise',
    type: 'prompt',
    turn: 1,
    prompt: 'Add a line saying we move indoors to the library hall if it rains, and use warmer colors.',
    anchor: 'send-message-btn',
    anchorScope: '[data-testid="session-bottom-container"]',
    placement: 'above',
    title: 'Change it by asking',
    body: 'Send this follow-up. You change an artifact in plain words, and an updated flyer comes back below the first one.',
  },
  {
    id: 'artifacts-done',
    type: 'bridge',
    title: 'Keep what you make',
    body: 'Every artifact is saved under Artifacts in the sidebar. Ask the same way for a diagram, a chart or code. Next, try one of your own.',
    action: 'Done',
  },
];
