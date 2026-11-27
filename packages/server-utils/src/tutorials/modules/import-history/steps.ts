import type { TutorialStep } from '@bike4mind/common';

export const IMPORT_HISTORY_PROMPT = 'How do I bring my chat history over from ChatGPT or Claude?';

// The export happens in the other app, so nothing here waits on a file: every step past the question is a
// plain point step the learner can move past with or without an export in hand.
export const IMPORT_HISTORY_STEPS: TutorialStep[] = [
  {
    id: 'import-history-ask',
    type: 'prompt',
    turn: 0,
    prompt: IMPORT_HISTORY_PROMPT,
    // The whole composer, not Send: a phone shows Send only once the box has text.
    anchor: 'session-bottom-container',
    placement: 'above',
    title: 'Ask how it works',
    body: 'Press Paste the message to put a question about importing in the message box, then press Send.',
  },
  {
    id: 'import-history-export',
    type: 'point',
    // Bottom-left: the default bottom-right corner covers the end of the recorded answer.
    placement: 'left',
    title: 'Export comes first',
    body: 'The answer shows where to export. A download link for the .zip arrives later by email. No export yet? Carry on, the next steps show where it goes.',
  },
  {
    id: 'import-history-open-profile',
    type: 'point',
    anchor: 'profile-menu-card',
    placement: 'right',
    title: 'Open your profile',
    body: 'Imports live in your settings. Open the side menu (the menu button on a phone), then your account menu at its foot, and press Profile. Then press Next.',
  },
  {
    id: 'import-history-settings',
    type: 'point',
    anchor: 'settings-tab',
    placement: 'below',
    title: 'Open Settings',
    body: 'On your Profile page, open the Settings tab, then press Next.',
  },
  {
    id: 'import-history-open-importer',
    type: 'point',
    anchor: 'settings-import-history-btn',
    placement: 'below',
    title: 'Open the importer',
    body: 'In Settings, press Import LLM History to open the importer, then press Next.',
  },
  // No anchor: the dialog covers the page, and an anchored card on a phone docks on the edge away from the
  // anchor, over the dialog's own button. Unanchored, the card docks above what it avoids.
  {
    id: 'import-history-upload',
    type: 'point',
    placement: 'left',
    avoid: '[data-testid="import-history-submit-btn"]',
    title: 'Upload your export',
    body: 'Set the switch to OpenAI for ChatGPT, or to Claude. Choose your .zip and press Upload. No file yet? Tap outside the box to close it. Then press Next.',
  },
  {
    id: 'import-history-after',
    type: 'point',
    // Bottom-left: the default bottom-right corner covers the end of the recorded answer.
    placement: 'left',
    title: 'It runs in the background',
    body: 'Each past chat becomes its own notebook in your list. Your inbox tells you when the import is done. Large exports can take a while.',
  },
  {
    id: 'import-history-done',
    type: 'bridge',
    title: 'Import any time',
    body: 'Import an export whenever it arrives, from Profile, then Settings. View Import History in the importer shows how each import went.',
    action: 'Done',
  },
];
