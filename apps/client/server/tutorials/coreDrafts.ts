// Core's tutorial drafts: the profile (what an admin may author on the main chat), its capture wiring and store.
// Server-only, like the registry (see registry.clientImports.test.ts).
import { z } from 'zod';
import { DOCKED_CHAT_BESIDE_PANE, WORKSPACE_SURFACES, type TutorialStep } from '@bike4mind/common';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { coreKnownSelectors, coreModels } from './core';
import { createDraftCore, type DraftProfile } from './drafts/draftCore';
import { scrubPlainTranscript, type CaptureDeps, type CaptureHooks } from './drafts/capture';
import { draftStore } from './drafts/store';
import { resolveCoreTutorial } from './registry';
import { anchorChoicesOf } from './routes/overridesRoute';
import { validateSheet, validateTutorialModule, type KnownSelectors } from './validate';

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
const knownSelectors: KnownSelectors = {
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
  validateModule: module => validateTutorialModule(module, { known: knownSelectors }),
  requireVisibility: true,
};

export const coreDraftCore = createDraftCore(CORE_DRAFT_PROFILE);

const captureDeps: CaptureDeps = {
  loadOwnedSession: async (sessionId, userId) =>
    (await sessionRepository.findByIdAndUserId(sessionId, userId)) as never,
  quests: async sessionId => (await questRepository.findAllBySessionId(sessionId)) as never,
};

const captureHooks: CaptureHooks<{ turn: number }> = {
  acceptsSurface: surface => !surface,
  foreignToolPrefixes: WORKSPACE_SURFACES.flatMap(s => (s.toolNamePrefix ? [s.toolNamePrefix] : [])),
  scrub: scrubPlainTranscript,
};

export const coreDraftStore = draftStore({
  models: coreModels,
  core: coreDraftCore,
  profile: CORE_DRAFT_PROFILE,
  capture: { deps: captureDeps, hooks: captureHooks },
  choices: { ...anchorChoicesOf(knownSelectors), canvasTabs: [] },
  validateSheet,
});
