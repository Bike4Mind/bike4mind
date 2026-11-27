import type { TutorialStep } from '@bike4mind/common';
import { PROJECTS_SHEET_NAME } from './sheet';

export const PROJECTS_PROMPT = `Using ${PROJECTS_SHEET_NAME}, what is due in week 2, and who owns each task?`;

// Plain point steps: the walk crosses to the Projects page and back, and the host keeps the card on screen there.
export const PROJECTS_STEPS: TutorialStep[] = [
  {
    id: 'projects-open',
    type: 'point',
    anchor: 'sidenav-nav-projects',
    placement: 'right',
    title: 'Open Projects',
    body: 'A project keeps notebooks and files together, so every chat in it starts from the same files. Open Projects in the side menu, then press Next.',
  },
  {
    id: 'projects-create',
    type: 'point',
    anchor: 'new-project-btn',
    placement: 'below',
    title: 'Make a project',
    body: 'Press New Project to open the form, then press Next.',
  },
  // The dialog steps carry no anchor: the dialog covers it, and an anchored card on a phone docks on the edge
  // away from the anchor, over the dialog's own buttons. Unanchored, the card docks above what it avoids.
  {
    id: 'projects-name',
    type: 'point',
    placement: 'left',
    avoid: '[data-testid="create-project-submit-btn"]',
    title: 'Name it',
    body: 'Give it a name, for example Website refresh, and press Create Project. Then press Next.',
  },
  {
    id: 'projects-files-tab',
    type: 'point',
    anchor: 'project-tab-files',
    placement: 'below',
    title: 'Add a file',
    body: 'Open Project Files and press File Browser, then press Next.',
  },
  {
    id: 'projects-pick-file',
    type: 'point',
    placement: 'left',
    avoid: '[data-testid="file-browser-add-files-btn"]',
    title: 'Pick the file',
    body: 'Pick sample-project-plan.csv and add it. We put that made-up file in your files for this. Then press Next.',
  },
  {
    id: 'projects-notebooks-tab',
    type: 'point',
    anchor: 'project-tab-notebooks',
    placement: 'below',
    title: 'Bring in this notebook',
    body: 'Open Notebooks and press Add Notebooks, then press Next.',
  },
  {
    id: 'projects-pick-notebook',
    type: 'point',
    placement: 'left',
    avoid: '[data-testid="generic-add-items-submit-btn"]',
    title: 'Pick this notebook',
    body: 'Tick the top Tutorial: Work in a project, the newest, and add it. Then press Next.',
  },
  {
    id: 'projects-open-notebook',
    type: 'point',
    anchor: 'project-session-title-link',
    placement: 'below',
    title: 'Open it from the project',
    body: 'Open the notebook from this list, then press Next. A notebook opened from its project can use the project files.',
  },
  {
    id: 'projects-ask',
    type: 'prompt',
    turn: 0,
    prompt: PROJECTS_PROMPT,
    // The whole composer, not Send: a phone shows Send only once the box has text.
    anchor: 'session-bottom-container',
    placement: 'above',
    title: 'Ask about the file',
    body: 'Press Paste the message to put a question about the project file in the message box, then press Send.',
  },
  {
    id: 'projects-done',
    type: 'bridge',
    title: 'Make it yours',
    body: 'Start a project for real work from Projects. To share one, invite teammates from its Members tab.',
    action: 'Done',
  },
];
