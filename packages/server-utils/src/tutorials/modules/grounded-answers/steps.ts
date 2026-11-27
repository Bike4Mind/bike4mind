import type { TutorialStep } from '@bike4mind/common';
import { GROUNDED_ANSWERS_SHEET_NAME } from './sheet';

export const GROUNDED_ANSWERS_PROMPT =
  'Using sample-team-faq.csv, how many vacation days do new staff get, and who approves them? Quote the line you used.';

export const GROUNDED_ANSWERS_STEPS: TutorialStep[] = [
  {
    id: 'grounded-answers-attach',
    type: 'attach',
    anchor: 'attach-files-btn',
    params: { fileName: GROUNDED_ANSWERS_SHEET_NAME },
    title: 'Add a file',
    body: 'We put a small made-up file, sample-team-faq.csv, in your files. Add it to this notebook so answers can use it.',
    doneBody: 'Added. The file is now part of this notebook.',
  },
  {
    id: 'grounded-answers-ask',
    type: 'prompt',
    turn: 0,
    prompt: GROUNDED_ANSWERS_PROMPT,
    // The whole composer, not Send: a phone shows Send only once the box has text.
    anchor: 'session-bottom-container',
    placement: 'above',
    title: 'Ask about it',
    body: 'A question about the file is waiting in the message box. Press Send.',
  },
  {
    id: 'grounded-answers-check',
    type: 'point',
    anchor: 'session-files-btn',
    placement: 'above',
    title: 'Check the source',
    body: 'The answer quotes the row it used. This lists the files in this notebook, so you can open the file and check.',
  },
  {
    id: 'grounded-answers-done',
    type: 'bridge',
    title: 'Use your own files',
    body: 'Add your own files with + in any notebook. They stay in Files Manager. To share a set of files across chats, start a Project.',
    action: 'Done',
  },
];
