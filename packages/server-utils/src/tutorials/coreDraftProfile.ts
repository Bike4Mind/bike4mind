// Core's draft profile: what an admin may author on the main chat. Free of the database so the apply script can
// load it; coreDrafts.ts wires capture and the store around it.
import { z } from 'zod';
import { DOCKED_CHAT_BESIDE_PANE, type TutorialStep } from '@bike4mind/common';
import { CORE_TUTORIAL_CONTENT } from './content';
import { createDraftCore, type DraftProfile } from './drafts/draftCore';
import { resolveCoreTutorial } from './registry';
import { knownSelectorsOf, validateTutorialModule, type KnownSelectors } from './validate';

export const coreKnownSelectors = knownSelectorsOf(CORE_TUTORIAL_CONTENT.map(t => ({ steps: [...t.steps] })));

const SEND = 'send-message-btn';
const ATTACH = 'attach-files-btn';
const COMPOSER = '[data-testid="session-bottom-container"]';
const CHAT = `${DOCKED_CHAT_BESIDE_PANE}, ${COMPOSER}, [data-testid="composer-status-line"]`;

/** The anchors a starter step uses, which render in the main chat whether or not a shipped module names them. */
export const CORE_DRAFT_SELECTORS: KnownSelectors = {
  anchors: new Set([SEND, ATTACH]),
  anchorScopes: new Set([COMPOSER]),
  avoids: new Set([CHAT]),
};

const union = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b]);
export const coreDraftKnownSelectors: KnownSelectors = {
  anchors: union(coreKnownSelectors.anchors, CORE_DRAFT_SELECTORS.anchors),
  anchorScopes: union(coreKnownSelectors.anchorScopes, CORE_DRAFT_SELECTORS.anchorScopes),
  avoids: union(coreKnownSelectors.avoids, CORE_DRAFT_SELECTORS.avoids),
};

const noParams = z.object({}).strict().optional();

function starterSteps(transcript: readonly { attachSheet?: boolean }[]): TutorialStep[] {
  return transcript.flatMap((t, turn): TutorialStep[] => {
    const id = `turn-${turn}`;
    const attach: TutorialStep[] = t.attachSheet
      ? [
          {
            id: `${id}-attach`,
            type: 'attach',
            anchor: ATTACH,
            title: 'Hand over the sheet',
            body: 'The sheet is waiting in your files: add it to the chat.',
            doneBody: 'The sheet is attached. Press Next.',
          },
        ]
      : [];
    const send: TutorialStep =
      turn === 0
        ? { id, type: 'prompt', turn, placement: 'right', avoid: CHAT, title: 'Say it plainly', body: 'Send it.' }
        : {
            id,
            type: 'prompt',
            turn,
            anchor: SEND,
            anchorScope: COMPOSER,
            placement: 'right',
            avoid: CHAT,
            title: 'Ask',
            body: 'Press Send.',
          };
    return [...attach, send];
  });
}

export const CORE_DRAFT_PROFILE: DraftProfile = {
  params: {
    prompt: noParams,
    point: noParams,
    dismiss: noParams,
    attach: z.object({ fileName: z.string().min(1) }).strict(),
  },
  sendTypes: ['prompt'],
  attachType: 'attach',
  starterSteps,
  defaultFinale: {
    title: 'You walked it end to end',
    body: 'You asked, attached your sheet and got the answer.',
  },
  isRepoModuleId: id => resolveCoreTutorial(id) !== null,
  withFinale: steps => steps,
  validateModule: module => validateTutorialModule(module, { known: coreDraftKnownSelectors }),
  requireVisibility: true,
};

export const coreDraftCore = createDraftCore(CORE_DRAFT_PROFILE);
