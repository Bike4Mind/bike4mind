// A test-only core tutorial. It is never added to CORE_TUTORIALS or CORE_TUTORIAL_CONTENT: tests that need it
// register it by mocking those modules.
import type { CoreTutorial } from '../registry';
import type { OverridePolicy } from '../overrides';
import type { RepoTutorial } from '../types';

export const FIXTURE_ENTITLEMENT = 'fixture:feature';

export const FIXTURE_REGISTRY: CoreTutorial = {
  id: 'fixture',
  title: 'Fixture tutorial',
  visibility: { entitlement: FIXTURE_ENTITLEMENT },
  enabled: true,
};

export const FIXTURE_CONTENT: RepoTutorial = {
  intro: {
    id: 'fixture',
    title: 'Fixture tutorial',
    pitch: 'A walk used by tests.',
    openingPrompt: 'Hello fixture',
    sheet: { name: 'fixture.csv', csv: 'a,b\n1,2\n' },
  },
  version: 1,
  enabled: true,
  steps: [
    {
      id: 'open',
      type: 'prompt',
      title: 'Say hello',
      body: 'Send the opening message.',
      turn: 0,
      prompt: 'Hello fixture',
      anchor: 'composer-input',
      placement: 'above',
    },
    {
      id: 'ask',
      type: 'prompt',
      title: 'Ask a question',
      body: 'Ask what this is.',
      doneBody: 'Read the answer.',
      turn: 1,
      prompt: 'What is this?',
    },
    { id: 'done', type: 'point', title: 'All done', body: 'That is the tour.' },
  ],
  transcript: [
    { prompt: 'Hello fixture', reply: 'Hi there.' },
    { prompt: 'What is this?', reply: 'A fixture.', attachSheet: true },
  ],
};

export const FIXTURE_POLICY: OverridePolicy = {
  editable: {
    fixture: { open: ['title', 'body'], ask: ['title', 'body', 'doneBody', 'prompt'], done: ['title', 'body'] },
  },
  pinned: { fixture: { done: ['title'] } },
};
